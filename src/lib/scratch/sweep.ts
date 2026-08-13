import { readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { SCRATCH_DIR, SCRATCH_TTL_MS } from "./config";

/**
 * Delete scratch files older than the TTL from `<rootDir>/.scratch`.
 *
 * Containment: the real workspace root and the real scratch dir are resolved,
 * and the scratch dir must stay inside the root (a `.scratch` symlink pointing
 * outside is ignored). Each deletion target's realpath is re-checked to stay
 * inside the scratch dir, so a symlinked entry cannot cause an out-of-root
 * delete. Best-effort: missing dir or per-entry errors are ignored. Returns the
 * number of entries removed.
 */
export async function sweepScratch(
	rootDir: string,
	now: number = Date.now(),
): Promise<number> {
	if (!rootDir) return 0;

	let realRoot: string;
	let realScratch: string;
	try {
		realRoot = await realpath(rootDir);
	} catch {
		return 0;
	}
	try {
		realScratch = await realpath(path.join(realRoot, SCRATCH_DIR));
	} catch {
		return 0;
	}
	// Scratch dir must live inside the real root; reject symlink escape.
	const rel = path.relative(realRoot, realScratch);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return 0;

	let names: string[];
	try {
		names = await readdir(realScratch);
	} catch {
		return 0;
	}

	let removed = 0;
	await Promise.all(
		names.map(async (name) => {
			const full = path.join(realScratch, name);
			try {
				// Re-check the entry stays inside the scratch dir (no symlink escape).
				const realFull = await realpath(full);
				const entryRel = path.relative(realScratch, realFull);
				if (entryRel.startsWith("..") || path.isAbsolute(entryRel)) return;

				const info = await stat(realFull);
				if (now - info.mtimeMs > SCRATCH_TTL_MS) {
					await rm(realFull, { recursive: true, force: true });
					removed += 1;
				}
			} catch {
				/* ignore per-entry errors */
			}
		}),
	);
	return removed;
}
