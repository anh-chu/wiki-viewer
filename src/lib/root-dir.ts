import path from "node:path";
import os from "node:os";

function getRootDir(): string {
	const env = process.env.ROOT_DIR;
	if (env) {
		return path.resolve(env);
	}
	// Fallback: ~/wiki-viewer-files
	return path.join(os.homedir(), "wiki-viewer-files");
}

export const ROOT_DIR = getRootDir();

export function safeRootPath(rel: string): string | null {
	if (!rel || rel === ".") return ROOT_DIR;
	const resolved = path.resolve(ROOT_DIR, rel);
	if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep))
		return null;
	return resolved;
}
