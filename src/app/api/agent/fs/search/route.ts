/**
 * Tier-1 Raw FS — server-side search.
 *
 * POST /api/agent/fs/search
 * Body: {
 *   kind: "grep" | "glob" | "fts",
 *   query: string,          // grep: regex pattern; glob: glob pattern; fts: literal
 *   path?: string,          // root-relative start path (default: root)
 *   limit?: number,         // max matches (default 200, hard cap 2000)
 * }
 *
 * Returns { kind, query, matches: [{path, line?, col?, text?}], truncated }.
 *
 * All three kinds are backed by ripgrep — no more JS tree walks.
 */
export const runtime = "nodejs";

import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import { matchGlob } from "@/lib/proof/glob";
import { rgRegexSearch, rgLiteralSearch, rgListFiles } from "@/lib/search/rg-search";
import type { Agent } from "@/lib/proof/registry";

const HARD_MAX_MATCHES = 2_000;
const SEARCH_TIMEOUT_MS = 10_000;

export interface SearchMatch {
	path: string;
	line?: number;
	col?: number;
	text?: string;
	score?: number;
	snippet?: string;
}

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
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

	if (body.kind !== "grep" && body.kind !== "glob" && body.kind !== "fts") {
		return errJson("INVALID_PAYLOAD", 'kind must be "grep", "glob", or "fts"', 400);
	}
	if (typeof body.query !== "string") {
		return errJson("INVALID_PAYLOAD", "query (string) required", 400);
	}
	if (body.kind !== "fts" && !body.query) {
		return errJson("INVALID_PAYLOAD", "query (string) required", 400);
	}

	const kind = body.kind as "grep" | "glob" | "fts";
	const query = body.query as string;
	const startRelRaw = typeof body.path === "string" ? body.path : "";
	const limit = Math.min(
		typeof body.limit === "number" ? body.limit : 200,
		HARD_MAX_MATCHES,
	);

	const wsx = await resolveWorkspaceForAgent(req);
	if (!wsx.ok) return errJson(wsx.code, wsx.code, wsx.status);
	const { ws, rootDir } = wsx;

	// Validate start path
	if (startRelRaw) {
		if (!safeWorkspacePath(rootDir, startRelRaw)) {
			return errJson("INVALID_PATH", "path: traversal rejected", 400);
		}
		const safe = await safeAbsPath(rootDir, startRelRaw);
		if (!safe) return errJson("INVALID_PATH", "path: rejected (symlink escape or denied)", 400);
	}

	// Verify start path is a directory
	let startPath: string | undefined;
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
		startPath = startRelRaw;
	}

	// ── GREP branch ──────────────────────────────────────────────────────────
	if (kind === "grep") {
		const sc = enforceScope(auth.agent, { op: "read", workspaceId: ws.id });
		if (!sc.ok) return errJson("FORBIDDEN", sc.message ?? "Forbidden", 403);

		const result = await rgRegexSearch(rootDir, query, {
			limit,
			timeoutMs: SEARCH_TIMEOUT_MS,
			startPath,
		});

		if (!result.ok && result.reason === "unavailable") {
			return errJson("SEARCH_UNAVAILABLE", "ripgrep not available; set WIKI_VIEWER_RG to override", 503);
		}
		if (!result.ok && result.reason === "invalid-pattern") {
			return errJson("SEARCH_ERROR", result.message, 400);
		}

		const hits = (result.ok ? result.results : result.partialResults) ?? [];

		// Enforce scope per result (rg already scoped to startPath).
		const matches: SearchMatch[] = [];
		for (const hit of hits) {
			const scopeCheck = enforceScope(auth.agent, { filePath: hit.path, op: "read", workspaceId: ws.id });
			if (!scopeCheck.ok) continue;
			matches.push({
				path: hit.path,
				line: hit.line,
				col: hit.col,
				text: hit.text,
			});
			if (matches.length >= limit) break;
		}

		const truncated = result.ok ? result.truncated : true;
		return NextResponse.json({ kind, query, matches, truncated });
	}

	// ── GLOB branch ──────────────────────────────────────────────────────────
	if (kind === "glob") {
		const sc = enforceScope(auth.agent, { op: "read", workspaceId: ws.id });
		if (!sc.ok) return errJson("FORBIDDEN", sc.message ?? "Forbidden", 403);

		const result = await rgListFiles(rootDir, {
			limit: HARD_MAX_MATCHES,
			timeoutMs: SEARCH_TIMEOUT_MS,
			startPath,
		});

		if (!result.ok && result.reason === "unavailable") {
			return errJson("SEARCH_UNAVAILABLE", "ripgrep not available; set WIKI_VIEWER_RG to override", 503);
		}

		const paths = (result.ok ? result.results : result.partialResults) ?? [];

		// Filter by glob pattern AND scope (rg already scoped to startPath).
		const matches: SearchMatch[] = [];
		for (const fileRel of paths) {
			const scopeCheck = enforceScope(auth.agent, { filePath: fileRel, op: "read", workspaceId: ws.id });
			if (!scopeCheck.ok) continue;

			// Match pattern against relative path OR just the filename.
			const baseName = path.basename(fileRel);
			if (!matchGlob(query, fileRel) && !matchGlob(query, baseName)) continue;

			matches.push({ path: fileRel });
			if (matches.length >= limit) break;
		}

		const truncated = result.ok ? result.truncated : true;
		return NextResponse.json({ kind, query, matches, truncated });
	}

	// ── FTS branch ───────────────────────────────────────────────────────────
	const sc = enforceScope(auth.agent, { op: "read", workspaceId: ws.id });
	if (!sc.ok) return errJson("FORBIDDEN", sc.message ?? "Forbidden", 403);

	const result = await rgLiteralSearch(rootDir, query, {
		limit,
		timeoutMs: SEARCH_TIMEOUT_MS,
		startPath,
	});

	if (!result.ok && result.reason === "unavailable") {
		return errJson("SEARCH_UNAVAILABLE", "ripgrep not available; set WIKI_VIEWER_RG to override", 503);
	}

	const ftsHits = (result.ok ? result.results : result.partialResults) ?? [];

	const ftsMatches: SearchMatch[] = [];
	for (const hit of ftsHits) {
		const scopeCheck = enforceScope(auth.agent, { filePath: hit.path, op: "read", workspaceId: ws.id });
		if (!scopeCheck.ok) continue;
		ftsMatches.push({
			path: hit.path,
			score: hit.score,
			snippet: hit.firstMatch.snippet,
			line: hit.firstMatch.line,
		});
		if (ftsMatches.length >= limit) break;
	}

	const ftsTruncated = result.ok ? result.truncated : true;
	return NextResponse.json({ kind, query, matches: ftsMatches, truncated: ftsTruncated });
}
