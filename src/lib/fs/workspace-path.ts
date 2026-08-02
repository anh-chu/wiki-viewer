import { realpath } from "node:fs/promises";
import path from "node:path";

export interface ResolveWorkspacePathOptions {
	/** Allow the final path segment to not exist; the nearest existing ancestor must still lie inside the workspace. */
	allowMissing?: boolean;
	/** Reject any relative path that contains these exact path segments. */
	deniedSegments?: string[];
}

function containsNul(s: string): boolean {
	return s.includes("\0");
}

function normalizeRel(raw: string): string | null {
	if (containsNul(raw)) return null;

	// Reject raw absolute paths before we mangle separators.  On Windows this
	// catches "C:\"; on POSIX it catches leading "/".
	if (path.isAbsolute(raw)) return null;

	let norm = raw.replace(/\\/g, "/");
	norm = path.posix.normalize(norm);

	if (norm === "." || norm === "./") norm = "";

	// Reject traversal, empty-root-relative "..", and Windows-drive leftovers.
	if (norm === "..") return null;
	if (norm.startsWith("../")) return null;
	if (/^[a-zA-Z]:\//.test(norm)) return null;
	if (norm.startsWith("/")) return null;

	return norm;
}

function isOutsideRoot(relToRoot: string): boolean {
	if (path.isAbsolute(relToRoot)) return true;
	if (relToRoot === "..") return true;
	if (relToRoot.startsWith(".." + path.sep)) return true;
	if (relToRoot.startsWith("../")) return true;
	return false;
}

/**
 * Resolve a workspace-relative path against the real workspace root.
 *
 * - Normalizes backslashes to forward slashes.
 * - Rejects absolute paths, NUL bytes, `..` traversal, and configured denied
 *   segments by exact segment equality.
 * - Resolves the workspace root with realpath().
 * - For an existing target, resolves its realpath and verifies it stays inside
 *   the real root.  Symlink escapes are rejected here.
 * - For missing targets with `allowMissing: true`, walks parents upward until
 *   realpath() succeeds and requires that nearest existing ancestor to stay
 *   inside the real root.  This prevents `link/new/file` escapes where `link`
 *   is a symlink to an outside directory.
 *
 * Returns `{ relPath, absolutePath }` together so callers never reconstruct
 * the absolute path differently.  Returns `null` when the path is rejected.
 */
export async function resolveWorkspacePath(
	rootDir: string,
	relPath: string,
	options: ResolveWorkspacePathOptions = {},
): Promise<{ relPath: string; absolutePath: string } | null> {
	if (!rootDir) return null;

	const norm = normalizeRel(relPath);
	if (norm === null) return null;

	if (options.deniedSegments?.length) {
		const segments = norm.split("/").filter(Boolean);
		for (const segment of segments) {
			if (options.deniedSegments.includes(segment)) return null;
		}
	}

	let realRoot: string;
	try {
		realRoot = await realpath(rootDir);
	} catch {
		return null;
	}

	const absolutePath = norm ? path.join(realRoot, norm) : realRoot;

	try {
		const realTarget = await realpath(absolutePath);
		const rel = path.relative(realRoot, realTarget);
		if (isOutsideRoot(rel)) return null;
		return { relPath: norm, absolutePath: realTarget };
	} catch {
		if (!options.allowMissing) return null;

		let cur = absolutePath;
		while (true) {
			const parent = path.dirname(cur);
			if (parent === cur) break;

			try {
				const realParent = await realpath(parent);
				const rel = path.relative(realRoot, realParent);
				if (isOutsideRoot(rel)) return null;
				return { relPath: norm, absolutePath };
			} catch {
				cur = parent;
			}
		}

		return null;
	}
}
