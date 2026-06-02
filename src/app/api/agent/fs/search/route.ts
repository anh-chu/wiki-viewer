/**
 * Tier-1 Raw FS — server-side search.
 *
 * POST /api/agent/fs/search
 * Body: {
 *   kind: "grep" | "glob",
 *   query: string,          // grep: regex string; glob: glob pattern
 *   path?: string,          // root-relative start path (default: root)
 *   limit?: number,         // max matches (default 200, hard cap 2000)
 * }
 *
 * Returns { kind, query, matches: [{path, line?, col?, text?}], truncated }.
 *
 * - Pure JS (no shell interpolation, no rg dependency)
 * - Skips binary files (null-byte heuristic) for grep
 * - Skips .proof/ and .git/
 * - Re-checks scope on every matched path
 */
export const runtime = "nodejs";

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { getRootDir, safeRootPath } from "@/lib/root-dir";
import { safeAbsPath, looksLikeBinary } from "@/lib/proof/raw-fs";
import { matchGlob } from "@/lib/proof/glob";
import type { Agent } from "@/lib/proof/registry";

const HARD_MAX_MATCHES = 2_000;
const HARD_MAX_SCAN_BYTES = 50 * 1024 * 1024; // 50 MB total
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchMatch {
	path: string;
	line?: number;
	col?: number;
	text?: string;
}

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

const SKIP_DIRS = new Set([".proof", ".git", "node_modules", ".next"]);

// ── Walk helpers ──────────────────────────────────────────────────────────────

async function* walkFiles(rootDir: string, relDir: string): AsyncGenerator<string> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let items: any[];
	try {
		items = await readdir(path.join(rootDir, relDir), { withFileTypes: true }) as any[];
	} catch {
		return;
	}
	for (const item of items) {
		if (SKIP_DIRS.has(item.name as string)) continue;
		const childRel = relDir ? `${relDir}/${item.name as string}` : item.name as string;
		if (item.isDirectory()) {
			yield* walkFiles(rootDir, childRel);
		} else if (item.isFile() || item.isSymbolicLink()) {
			yield childRel;
		}
	}
}

// ── Grep ─────────────────────────────────────────────────────────────────────

async function grepSearch(
	rootDir: string,
	startRel: string,
	pattern: string,
	limit: number,
	agent: Agent,
	deadline: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "d");
	} catch {
		// fallback without indices flag
		try {
			regex = new RegExp(pattern);
		} catch {
			throw new Error("Invalid regex pattern");
		}
	}

	const matches: SearchMatch[] = [];
	let scannedBytes = 0;

	for await (const fileRel of walkFiles(rootDir, startRel)) {
		if (matches.length >= limit) return { matches, truncated: true };
		if (Date.now() > deadline) return { matches, truncated: true };

		const sc = enforceScope(agent, { filePath: fileRel, op: "read" });
		if (!sc.ok) continue;

		let buf: Buffer;
		try {
			buf = await readFile(path.join(rootDir, fileRel));
		} catch {
			continue;
		}

		scannedBytes += buf.length;
		if (scannedBytes > HARD_MAX_SCAN_BYTES) return { matches, truncated: true };

		if (looksLikeBinary(buf)) continue;

		const text = buf.toString("utf-8");
		const lines = text.split("\n");
		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			if (matches.length >= limit) return { matches, truncated: true };
			const lineText = lines[lineIdx]!;
			// Reset lastIndex for global regexes
			regex.lastIndex = 0;
			const m = regex.exec(lineText);
			if (m) {
				matches.push({
					path: fileRel,
					line: lineIdx + 1,
					col: (m.index ?? 0) + 1,
					text: lineText,
				});
			}
		}
	}

	return { matches, truncated: false };
}

// ── Glob ─────────────────────────────────────────────────────────────────────

async function globSearch(
	rootDir: string,
	startRel: string,
	pattern: string,
	limit: number,
	agent: Agent,
	deadline: number,
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
	const matches: SearchMatch[] = [];

	for await (const fileRel of walkFiles(rootDir, startRel)) {
		if (matches.length >= limit) return { matches, truncated: true };
		if (Date.now() > deadline) return { matches, truncated: true };

		// Match pattern against relative path OR just the filename
		const baseName = path.basename(fileRel);
		if (!matchGlob(pattern, fileRel) && !matchGlob(pattern, baseName)) continue;

		const sc = enforceScope(agent, { filePath: fileRel, op: "read" });
		if (!sc.ok) continue;

		matches.push({ path: fileRel });
	}

	return { matches, truncated: false };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	let body: { kind?: unknown; query?: unknown; path?: unknown; limit?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return errJson("INVALID_PAYLOAD", "Invalid JSON body", 400);
	}

	if (body.kind !== "grep" && body.kind !== "glob") {
		return errJson("INVALID_PAYLOAD", 'kind must be "grep" or "glob"', 400);
	}
	if (typeof body.query !== "string" || !body.query) {
		return errJson("INVALID_PAYLOAD", "query (string) required", 400);
	}

	const kind = body.kind as "grep" | "glob";
	const query = body.query as string;
	const startRelRaw = typeof body.path === "string" ? body.path : "";
	const limit = Math.min(
		typeof body.limit === "number" ? body.limit : 200,
		HARD_MAX_MATCHES,
	);

	// Validate start path
	if (startRelRaw) {
		if (!safeRootPath(startRelRaw)) {
			return errJson("INVALID_PATH", "path: traversal rejected", 400);
		}
		const safe = await safeAbsPath(startRelRaw);
		if (!safe) return errJson("INVALID_PATH", "path: rejected (symlink escape or denied)", 400);
	}

	const rootDir = getRootDir();

	// Verify start path is a directory
	if (startRelRaw) {
		try {
			const st = await stat(path.join(rootDir, startRelRaw));
			if (!st.isDirectory()) {
				return errJson("NOT_A_DIRECTORY", "path must be a directory", 400);
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") {
				return errJson("NOT_FOUND", "Start path not found", 404);
			}
			throw e;
		}
	}

	const deadline = Date.now() + SEARCH_TIMEOUT_MS;
	let result: { matches: SearchMatch[]; truncated: boolean };

	try {
		if (kind === "grep") {
			result = await grepSearch(rootDir, startRelRaw, query, limit, auth.agent, deadline);
		} else {
			result = await globSearch(rootDir, startRelRaw, query, limit, auth.agent, deadline);
		}
	} catch (e) {
		return errJson("SEARCH_ERROR", (e as Error).message, 400);
	}

	return NextResponse.json({
		kind,
		query,
		matches: result.matches,
		truncated: result.truncated,
	});
}
