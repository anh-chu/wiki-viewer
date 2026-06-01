/**
 * Cross-process file locking via proper-lockfile.
 *
 * Uses a sentinel file in ~/.wiki-viewer/.locks/ keyed by a hash of the lock
 * key so the actual data file need not exist before locking.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

function locksDir(): string {
	const home = process.env.HOME ?? os.homedir();
	return path.join(home, ".wiki-viewer", ".locks");
}

function sentinelPath(lockKey: string): string {
	const hash = createHash("sha256").update(lockKey, "utf8").digest("hex").slice(0, 32);
	return path.join(locksDir(), hash);
}

export async function withFileLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
	const dir = locksDir();
	await mkdir(dir, { recursive: true });
	const sentinel = sentinelPath(lockKey);
	// Create sentinel if absent (flag "a" = append/create, never truncate)
	await writeFile(sentinel, "", { flag: "a" });

	const release = await lockfile.lock(sentinel, {
		retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 2_000 },
	});
	try {
		return await fn();
	} finally {
		await release();
	}
}
