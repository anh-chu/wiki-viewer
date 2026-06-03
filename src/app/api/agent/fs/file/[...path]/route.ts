/**
 * Tier-1 Raw FS — file read/write/delete.
 *
 * GET    /api/agent/fs/file/<path>          Read raw bytes (Range supported).
 * PUT    /api/agent/fs/file/<path>          Atomic whole-file write.
 * DELETE /api/agent/fs/file/<path>          Delete file (+ sidecar for .md).
 */
export const runtime = "nodejs";

import { readFile, stat, unlink, rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { getRootDir, safeRootPath } from "@/lib/root-dir";
import { withFileMutex } from "@/lib/proof/mutex";
import { readSidecar, emptySidecar, deleteSidecar } from "@/lib/proof/sidecar";
import { reconcileSidecar } from "@/lib/proof/ops-applier";
import { writeAuditRow } from "@/lib/proof/audit";
import {
	safeAbsPath,
	sha256ofBuf,
	extractShaHex,
	mimeByExt,
	isMarkdown,
	atomicWrite,
	ensureParentDir,
	looksLikeBinary,
} from "@/lib/proof/raw-fs";
import { computeCollabState } from "@/lib/proof/collab-state";

// ── Helpers ──────────────────────────────────────────────────────────────────

function rel(segments: string[]): string {
	return segments.join("/");
}

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	const { path: segments } = await params;
	const relPath = rel(segments);

	const basic = safeRootPath(relPath);
	if (!basic) return errJson("INVALID_PATH", "Path traversal rejected", 400);

	const absPath = await safeAbsPath(relPath);
	if (!absPath) return errJson("INVALID_PATH", "Path rejected (symlink escape or denied)", 400);

	const scope = enforceScope(auth.agent, { filePath: relPath, op: "read" });
	if (!scope.ok) return errJson(scope.code, scope.message, 403);

	let data: Buffer;
	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		[data, fileStat] = await Promise.all([readFile(absPath), stat(absPath)]);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return errJson("NOT_FOUND", "File not found", 404);
		}
		throw e;
	}

	if (fileStat.isDirectory()) {
		return errJson("IS_DIRECTORY", "Path is a directory; use /api/agent/fs/ls/", 400);
	}

	const sha = sha256ofBuf(data);
	const baseHeaders: Record<string, string> = {
		"ETag": `"${sha}"`,
		"X-File-Size": String(fileStat.size),
		"X-File-Mtime": fileStat.mtime.toISOString(),
		"Content-Type": mimeByExt(relPath),
		"Accept-Ranges": "bytes",
	};

	// X-Collab-* headers (§3.5 mode signal)
	const rootDir = getRootDir();
	const collab = await computeCollabState(rootDir, relPath);
	if (collab.state !== "not-markdown") {
		baseHeaders["X-Collab-State"] = collab.state;
		baseHeaders["X-Collab-Revision"] = String(collab.revision);
		baseHeaders["X-Collab-Snapshot"] = collab.snapshotUrl!;
	} else {
		baseHeaders["X-Collab-State"] = collab.state;
	}

	const rangeHeader = req.headers.get("range");
	if (rangeHeader) {
		const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
		if (!match) {
			return new NextResponse("Invalid Range header", { status: 416 });
		}
		const start = parseInt(match[1]!, 10);
		const endRaw = match[2] ? parseInt(match[2], 10) : data.length - 1;
		if (start > endRaw || start >= data.length) {
			return new NextResponse(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${data.length}` },
			});
		}
		const end = Math.min(endRaw, data.length - 1);
		const slice = data.slice(start, end + 1);
		return new NextResponse(slice as unknown as BodyInit, {
			status: 206,
			headers: {
				...baseHeaders,
				"Content-Range": `bytes ${start}-${end}/${data.length}`,
				"Content-Length": String(slice.length),
			},
		});
	}

	return new NextResponse(data as unknown as BodyInit, {
		status: 200,
		headers: { ...baseHeaders, "Content-Length": String(data.length) },
	});
}

// ── Shared mutation path (PUT + PATCH) ────────────────────────────────────────

/**
 * Single code path for all Tier-1 byte mutations so PUT and PATCH cannot drift
 * on auth/scope/If-Match/R6/atomicWrite/reconcile/audit.
 *
 * `computeNewBody` receives the existing file buffer (or null if absent) and
 * returns the new bytes, or an error response to short-circuit (e.g. PATCH
 * match-count mismatch). `op` is the audit verb ("put" | "patch").
 */
async function applyMutation(
	req: Request,
	segments: string[],
	opts: {
		op: "put" | "patch";
		allowCreate: boolean;
		computeNewBody: (existing: Buffer | null) => Buffer | NextResponse;
	},
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	const relPath = rel(segments);
	const url = new URL(req.url);
	const mkdirs = url.searchParams.get("mkdirs") === "true";
	const force = url.searchParams.get("force") === "true";

	const basic = safeRootPath(relPath);
	if (!basic) return errJson("INVALID_PATH", "Path traversal rejected", 400);

	const absPath = await safeAbsPath(relPath);
	if (!absPath) return errJson("INVALID_PATH", "Path rejected (symlink escape or denied)", 400);

	const scope = enforceScope(auth.agent, { filePath: relPath, op: "mutate" });
	if (!scope.ok) return errJson(scope.code, scope.message, 403);

	const ifMatch = req.headers.get("if-match");
	const ifCollabMatch = req.headers.get("if-collab-match");
	const rootDir = getRootDir();

	// The whole read-existing → precondition → compute → write → reconcile → audit
	// sequence runs inside the mutex for .md (so R6 and reconcile are atomic with
	// the write); non-.md runs it without the mutex.
	const doMutation = async (): Promise<NextResponse> => {
		// Read existing
		let existingBuf: Buffer | null = null;
		let existingSha: string | undefined;
		try {
			existingBuf = await readFile(absPath);
			existingSha = sha256ofBuf(existingBuf);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		const existed = existingBuf !== null;

		if (existed) {
			// Overwrite: If-Match required by default (unless ?force=true)
			if (!force && !ifMatch) {
				return errJson(
					"PRECONDITION_REQUIRED",
					"If-Match header required for overwrites (use ?force=true to bypass with audit)",
					412,
				);
			}
			if (ifMatch && extractShaHex(ifMatch) !== extractShaHex(existingSha!)) {
				return errJson("PRECONDITION_FAILED", "If-Match sha256 mismatch", 412);
			}
		} else {
			if (!opts.allowCreate) {
				return errJson("NOT_FOUND", "File not found", 404);
			}
			const parentOk = await ensureParentDir(absPath, mkdirs);
			if (!parentOk) {
				return errJson(
					"PARENT_NOT_FOUND",
					"Parent directory does not exist (use ?mkdirs=true to create)",
					400,
				);
			}
		}

		// R6: for .md, re-check collab state atomically (inside mutex)
		if (isMarkdown(relPath)) {
			const { state, revision, snapshotUrl } = await computeCollabState(rootDir, relPath);
			if (state === "active") {
				const matchVal = ifCollabMatch?.trim();
				if (!force && (!matchVal || matchVal !== String(revision))) {
					return NextResponse.json(
						{
							error: "COLLAB_ACTIVE",
							message:
								"File is in active collaborative session. Use block-ops (Tier-2) or supply a matching If-Collab-Match header. Use ?force=true to override (audited).",
							snapshotUrl,
							revision,
						},
						{ status: 409 },
					);
				}
			}
		}

		// Compute new bytes (PUT: request body; PATCH: str-replace on existing)
		const computed = opts.computeNewBody(existingBuf);
		if (computed instanceof NextResponse) return computed;
		const bodyBuf = computed;
		const newSha = sha256ofBuf(bodyBuf);

		await atomicWrite(absPath, bodyBuf);

		if (isMarkdown(relPath)) {
			const content = bodyBuf.toString("utf-8");
			const sidecar = (await readSidecar(rootDir, relPath)) ?? emptySidecar(relPath);
			await reconcileSidecar({
				rootDir,
				mdPath: relPath,
				content,
				sidecar,
				by: auth.agent.id,
				eventType: "file.rawWritten",
				fingerprint: newSha,
			});
		}

		writeAuditRow({
			agentId: auth.agent.id,
			op: opts.op,
			path: relPath,
			oldSha: existingSha,
			newSha,
			forced: force,
		});

		const st = await stat(absPath);
		return NextResponse.json({
			path: relPath,
			sha256: newSha,
			size: st.size,
			mtime: st.mtime.toISOString(),
			created: !existed,
		});
	};

	return isMarkdown(relPath) ? withFileMutex(relPath, doMutation) : doMutation();
}

// ── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const { path: segments } = await params;
	const bodyBuf = Buffer.from(await req.arrayBuffer());
	return applyMutation(req, segments, {
		op: "put",
		allowCreate: true,
		computeNewBody: () => bodyBuf,
	});
}

// ── PATCH ─────────────────────────────────────────────────────────────────────
// Server-side str-replace so agents send only the change, not the whole file.
// Strict: exact substring (no regex), text/UTF-8 only, If-Match required,
// expectedOccurrences must match exactly (default 1). Shares applyMutation, so
// lock / R6 / reconcile / audit behave identically to PUT.

const MAX_PATCH_STRING = 1_000_000; // 1MB cap on find/replace strings

export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const { path: segments } = await params;

	let body: { find?: unknown; replace?: unknown; expectedOccurrences?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return errJson("INVALID_PAYLOAD", "Body must be JSON {find, replace, expectedOccurrences?}", 400);
	}
	const find = body.find;
	const replace = body.replace;
	if (typeof find !== "string" || typeof replace !== "string") {
		return errJson("INVALID_PAYLOAD", "find and replace must be strings", 400);
	}
	if (find.length === 0) {
		return errJson("INVALID_PAYLOAD", "find must not be empty", 400);
	}
	if (find.length > MAX_PATCH_STRING || replace.length > MAX_PATCH_STRING) {
		return errJson("PAYLOAD_TOO_LARGE", "find/replace exceeds 1MB limit", 413);
	}
	let expected = 1;
	if (body.expectedOccurrences !== undefined) {
		if (typeof body.expectedOccurrences !== "number" || !Number.isInteger(body.expectedOccurrences) || body.expectedOccurrences < 1) {
			return errJson("INVALID_PAYLOAD", "expectedOccurrences must be a positive integer", 400);
		}
		expected = body.expectedOccurrences;
	}

	return applyMutation(req, segments, {
		op: "patch",
		allowCreate: false, // patch only edits existing files
		computeNewBody: (existing) => {
			if (existing === null) return errJson("NOT_FOUND", "File not found", 404);
			if (looksLikeBinary(existing)) {
				return errJson("UNSUPPORTED", "Cannot patch binary / non-text file", 415);
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(existing);
			} catch {
				return errJson("UNSUPPORTED", "File is not valid UTF-8", 415);
			}
			// Count exact occurrences (no regex).
			let count = 0;
			let idx = text.indexOf(find);
			while (idx !== -1) {
				count++;
				idx = text.indexOf(find, idx + find.length);
			}
			if (count !== expected) {
				return NextResponse.json(
					{
						error: "MATCH_COUNT_MISMATCH",
						message: `Expected ${expected} occurrence(s) of find, found ${count}. Re-read the file or adjust expectedOccurrences.`,
						found: count,
						expected,
					},
					{ status: 422 },
				);
			}
			// Replace all (count == expected) occurrences, literally.
			return Buffer.from(text.split(find).join(replace), "utf-8");
		},
	});
}

// ── DELETE ───────────────────────────────────────────────────────────────────

export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	const { path: segments } = await params;
	const relPath = rel(segments);
	const url = new URL(req.url);
	const recursive = url.searchParams.get("recursive") === "true";

	const basic = safeRootPath(relPath);
	if (!basic) return errJson("INVALID_PATH", "Path traversal rejected", 400);

	const absPath = await safeAbsPath(relPath);
	if (!absPath) return errJson("INVALID_PATH", "Path rejected (symlink escape or denied)", 400);

	// Requires "delete" scope op
	const scope = enforceScope(auth.agent, { filePath: relPath, op: "delete" });
	if (!scope.ok) return errJson(scope.code, scope.message, 403);

	const ifMatch = req.headers.get("if-match");

	let fileStat: Awaited<ReturnType<typeof stat>>;
	try {
		fileStat = await stat(absPath);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return errJson("NOT_FOUND", "File not found", 404);
		}
		throw e;
	}

	if (fileStat.isDirectory()) {
		if (!recursive) {
			return errJson("IS_DIRECTORY", "Use ?recursive=true to delete a directory", 400);
		}
		// Directory delete — no single sha, skip If-Match; require recursive flag as confirmation
		await rm(absPath, { recursive: true, force: true });
		writeAuditRow({ agentId: auth.agent.id, op: "delete", path: relPath, forced: false });
		return NextResponse.json({ deleted: relPath });
	}

	// File: If-Match required as confirmation
	if (!ifMatch) {
		return errJson("PRECONDITION_REQUIRED", "If-Match header required for delete", 412);
	}

	const existing = await readFile(absPath);
	const existingSha = sha256ofBuf(existing);
	if (extractShaHex(ifMatch) !== extractShaHex(existingSha)) {
		return errJson("PRECONDITION_FAILED", "If-Match sha256 mismatch", 412);
	}

	const rootDir = getRootDir();

	if (isMarkdown(relPath)) {
		await withFileMutex(relPath, async () => {
			await unlink(absPath);
			await deleteSidecar(rootDir, relPath);
		});
	} else {
		await unlink(absPath);
	}

	writeAuditRow({ agentId: auth.agent.id, op: "delete", path: relPath, oldSha: existingSha, forced: false });
	return NextResponse.json({ deleted: relPath });
}
