/**
 * Synchronous cleanup of the obsolete SQLite search index.
 *
 * Deletes search.db, search.db-wal, and search.db-shm from ~/.wiki-viewer/.
 * The directory expression is deliberately HOME-based, matching the one the
 * now-deleted search-db module used, so tests that override HOME clean up the
 * same place the old index was written.
 *
 * Must never throw (ENOENT is a no-op under force; EACCES/EBUSY/EPERM
 * are swallowed). Safe to call unconditionally on every boot and from
 * two processes at once.
 *
 * Has no imports from the rest of src/lib/search/ — the index modules it
 * cleans up after no longer exist.
 */
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Internal ─────────────────────────────────────────────────────────────────

/** The data directory the deleted search index used: $HOME/.wiki-viewer. */
function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

// ── Public ───────────────────────────────────────────────────────────────────

export function deleteLegacySearchDb(): void {
	const dir = dataDir();
	const files = ["search.db", "search.db-wal", "search.db-shm"];
	const removed: string[] = [];

	for (const file of files) {
		try {
			const absPath = path.join(dir, file);
			if (existsSync(absPath)) {
				rmSync(absPath, { force: true });
				removed.push(file);
			}
		} catch (e: unknown) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EBUSY" || code === "EPERM") continue;
			// ENOENT handled by existsSync; other unexpected errors silently ignored.
		}
	}

	// One line, and only when something was actually removed.
	if (removed.length > 0) {
		console.log(`[legacy-db-cleanup] removed ${removed.join(", ")} from ${dir}`);
	}
}
