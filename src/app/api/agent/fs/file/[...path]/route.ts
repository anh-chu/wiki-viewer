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

// ── PUT ──────────────────────────────────────────────────────────────────────

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	const { path: segments } = await params;
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
	const bodyBuf = Buffer.from(await req.arrayBuffer());
	const newSha = sha256ofBuf(bodyBuf);

	// Check existing file
	let existingSha: string | undefined;
	let existed = false;
	try {
		const existing = await readFile(absPath);
		existingSha = sha256ofBuf(existing);
		existed = true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}

	if (existed) {
		// Overwrite: If-Match required by default (unless ?force=true)
		if (!force && !ifMatch) {
			return errJson(
				"PRECONDITION_REQUIRED",
				"If-Match header required for overwrites (use ?force=true to bypass with audit)",
				412,
			);
		}
		if (ifMatch) {
			const provided = extractShaHex(ifMatch);
			const current = extractShaHex(existingSha!);
			if (provided !== current) {
				return errJson("PRECONDITION_FAILED", "If-Match sha256 mismatch", 412);
			}
		}
	} else {
		// Create: ensure parent dir exists
		const parentOk = await ensureParentDir(absPath, mkdirs);
		if (!parentOk) {
			return errJson(
				"PARENT_NOT_FOUND",
				"Parent directory does not exist (use ?mkdirs=true to create)",
				400,
			);
		}
	}

	const rootDir = getRootDir();
	// R6: for .md, re-check collab state atomically inside write mutex
	const ifCollabMatch = req.headers.get("if-collab-match");

	if (isMarkdown(relPath)) {
		// R1: acquire shared mutex; R2: reconcile eagerly inside it
		return await withFileMutex(relPath, async () => {
			// R6: atomic collab-state check (closes TOCTOU race)
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

			await atomicWrite(absPath, bodyBuf);

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

			writeAuditRow({
				agentId: auth.agent.id,
				op: "put",
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
		});
	}

	// Non-.md: atomic write + audit (no mutex, no sidecar)
	await atomicWrite(absPath, bodyBuf);
	writeAuditRow({
		agentId: auth.agent.id,
		op: "put",
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
