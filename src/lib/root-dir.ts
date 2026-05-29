import path from "node:path";

// Use globalThis so the value persists across Next.js hot-reloads in dev.
const g = globalThis as typeof globalThis & { __wikiRootDir?: string };

// Initialise once from env on first import.
if (!g.__wikiRootDir && process.env.ROOT_DIR) {
	g.__wikiRootDir = path.resolve(process.env.ROOT_DIR);
}

export function getRootDir(): string {
	return g.__wikiRootDir ?? "";
}

export function isRootDirSet(): boolean {
	return !!g.__wikiRootDir;
}

export function setRootDir(dir: string): void {
	g.__wikiRootDir = path.resolve(dir);
}

/** Returns the absolute path for `rel`, or null on traversal / root not set. */
export function safeRootPath(rel: string): string | null {
	const root = getRootDir();
	if (!root) return null;
	if (!rel || rel === ".") return root;
	const resolved = path.resolve(root, rel);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
	return resolved;
}
