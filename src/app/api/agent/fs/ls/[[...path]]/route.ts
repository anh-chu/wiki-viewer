/**
 * Tier-1 Raw FS — directory listing.
 *
 * GET /api/agent/fs/ls[/<path>]?recursive&limit=N&depth=N
 *
 * Returns {path, entries, truncated}.
 * Each entry: {name, path, type, size?, mtime?}.
 * Excludes .proof/ and .git/. Scope-filters every returned path.
 */
export const runtime = "nodejs";

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import type { Agent } from "@/lib/proof/registry";

const HARD_MAX_ENTRIES = 10_000;
const HARD_MAX_DEPTH = 20;

export interface LsEntry {
	name: string;
	path: string;
	type: "file" | "dir" | "symlink";
	size?: number;
	mtime?: string;
}

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

/** Skip these names at any depth */
const SKIP_NAMES = new Set([".proof", ".git"]);

async function walkDir(
	rootDir: string,
	relDir: string,
	agent: Agent,
	recursive: boolean,
	depth: number,
	maxDepth: number,
	limit: number,
	results: LsEntry[],
	workspaceId?: string,
): Promise<void> {
	if (depth > maxDepth || results.length >= limit) return;

	const absDir = path.join(rootDir, relDir);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let items: any[];
	try {
		items = await readdir(absDir, { withFileTypes: true }) as any[];
	} catch {
		return;
	}

	for (const item of items) {
		if (results.length >= limit) break;
		if (SKIP_NAMES.has(item.name)) continue;

		const childRel = relDir ? `${relDir}/${item.name}` : item.name;

		// Scope check per entry
		const sc = enforceScope(agent, { filePath: childRel, op: "read", workspaceId });
		if (!sc.ok) continue;

		let type: LsEntry["type"];
		let size: number | undefined;
		let mtime: string | undefined;

		if (item.isSymbolicLink()) {
			type = "symlink";
		} else if (item.isDirectory()) {
			type = "dir";
		} else {
			type = "file";
			try {
				const st = await stat(path.join(rootDir, childRel));
				size = st.size;
				mtime = st.mtime.toISOString();
			} catch {
				// best-effort
			}
		}

		results.push({ name: item.name, path: childRel, type, size, mtime });

		if (recursive && type === "dir") {
			await walkDir(rootDir, childRel, agent, recursive, depth + 1, maxDepth, limit, results, workspaceId);
		}
	}
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	const { path: segments } = await params;
	const relPath = segments ? segments.join("/") : "";

	const wsx = await resolveWorkspaceForAgent(req);
	if (!wsx.ok) return errJson(wsx.code, wsx.code, wsx.status);
	const { ws, rootDir } = wsx;

	if (relPath) {
		const basic = safeWorkspacePath(rootDir, relPath);
		if (!basic) return errJson("INVALID_PATH", "Path traversal rejected", 400);
		const safe = await safeAbsPath(rootDir, relPath);
		if (!safe) return errJson("INVALID_PATH", "Path rejected (symlink escape or denied)", 400);
	}

	const url = new URL(req.url);
	const recursive = url.searchParams.has("recursive");
	const limit = Math.min(
		parseInt(url.searchParams.get("limit") ?? "1000", 10) || 1000,
		HARD_MAX_ENTRIES,
	);
	const depth = Math.min(
		parseInt(url.searchParams.get("depth") ?? "10", 10) || 10,
		HARD_MAX_DEPTH,
	);

	// Verify the dir actually exists
	const absDir = relPath ? path.join(rootDir, relPath) : rootDir;
	try {
		const st = await stat(absDir);
		if (!st.isDirectory()) {
			return errJson("NOT_A_DIRECTORY", "Path is not a directory", 400);
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return errJson("NOT_FOUND", "Directory not found", 404);
		}
		throw e;
	}

	const entries: LsEntry[] = [];
	await walkDir(rootDir, relPath, auth.agent, recursive, 0, depth, limit, entries, ws.id);

	return NextResponse.json({
		path: relPath,
		entries,
		truncated: entries.length >= limit,
	});
}
