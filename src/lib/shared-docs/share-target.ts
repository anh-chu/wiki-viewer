import { NextResponse } from "next/server";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getShareByToken, isExpired, type SharedDoc } from "./db";
import { getWorkspace } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export interface ResolvedShareTarget {
	share: SharedDoc;
	absPath: string;
	realRoot: string;
	filename: string;
}

/** The file or folder a share token points at. */
export interface ResolvedShareRoot {
	share: SharedDoc;
	/** Absolute path of the share root, as resolved on disk. */
	absPath: string;
	/** Realpath of absPath. This is the containment root for `rel` paths. */
	realRoot: string;
	isDir: boolean;
	filename: string;
}

export type ResolveResult<T> =
	| { ok: true; target: T }
	| { ok: false; response: NextResponse };

function error(
	status: number,
	code: string,
	message: string,
): { ok: false; response: NextResponse } {
	return { ok: false, response: NextResponse.json({ error: code, message }, { status }) };
}

/**
 * Resolve a share token to its root. Centralises share lookup, revocation,
 * expiry, workspace existence, path containment, and existence checks.
 */
export async function resolveShareRoot(
	token: string,
): Promise<ResolveResult<ResolvedShareRoot>> {
	const share = getShareByToken(token);
	if (!share) return error(404, "not_found", "Share link not found");
	if (share.isRevoked) return error(410, "revoked", "Share link has been revoked");
	if (isExpired(share)) return error(410, "expired", "Share link has expired");

	const ws = await getWorkspace(share.workspaceId);
	if (!ws) return error(410, "workspace_gone", "Workspace no longer exists");

	const absPath = await safeAbsPath(ws.rootDir, share.filePath);
	if (!absPath) return error(400, "path_invalid", "Invalid file path");

	let info: Awaited<ReturnType<typeof stat>>;
	let realRoot: string;
	try {
		info = await stat(absPath);
		realRoot = await realpath(absPath);
	} catch {
		return error(410, "file_gone", "File no longer exists");
	}

	return {
		ok: true,
		target: {
			share,
			absPath: realRoot,
			realRoot,
			isDir: info.isDirectory(),
			filename: path.basename(realRoot),
		},
	};
}

/**
 * Resolve a share token to a readable, non-directory file target.
 * File shares only; a folder share is rejected here so a file route can never
 * read a directory as a file.
 */
export async function resolveShareTarget(
	token: string,
): Promise<ResolveResult<ResolvedShareTarget>> {
	const resolved = await resolveShareRoot(token);
	if (!resolved.ok) return resolved;

	const { share, absPath, realRoot, isDir, filename } = resolved.target;
	if (isDir) return error(400, "path_invalid", "Directories cannot be shared");

	return { ok: true, target: { share, absPath, realRoot, filename } };
}

/** True when any segment of a share-relative path is hidden (starts with "."). */
function hasHiddenSegment(rel: string): boolean {
	if (!rel || rel === ".") return false;
	return rel.split(path.sep).some((segment) => segment.startsWith("."));
}

/**
 * Resolve `rel` inside a share root, or return null when it must not be served.
 *
 * The containment root is the SHARE root, never the workspace root: that is
 * what stops a `?path=` request from reading a sibling of the shared folder.
 * `resolveWorkspacePath` rejects absolute paths, `..`, and symlink escapes;
 * the hidden-segment check runs on the resolved path too, so a symlink that
 * points at a dotfile (for example `notes -> .env`) is refused as well.
 */
export async function resolveInShare(
	realRoot: string,
	rel: string,
): Promise<{ relPath: string; absolutePath: string } | null> {
	if (hasHiddenSegment(rel)) return null;

	const resolved = await resolveWorkspacePath(realRoot, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) return null;

	if (hasHiddenSegment(path.relative(realRoot, resolved.absolutePath))) return null;
	return resolved;
}
