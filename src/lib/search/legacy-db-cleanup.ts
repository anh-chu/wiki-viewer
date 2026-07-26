/**
 * Synchronous cleanup of the obsolete SQLite search index.
 *
 * Deletes search.db, search.db-wal, and search.db-shm from
 * ~/.wiki-viewer/ — the exact same directory expression used in
 * src/lib/search/search-db.ts:21-23 so tests that override HOME
 * behave identically.
 *
 * Must never throw (ENOENT is a no-op under force; EACCES/EBUSY/EPERM
 * are swallowed). Safe to call unconditionally on every boot and from
 * two processes at once.
 *
 * Does NOT import anything from src/lib/search/ — those modules are
 * about to be deleted.
 */
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * The data directory, matching the expression at
 * src/lib/search/search-db.ts:21-23 exactly.
 */
function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

// ── Public ───────────────────────────────────────────────────────────────────

export function deleteLegacySearchDb(): void {
	const dir = dataDir();
	const files = ["search.db", "search.db-wal", "search.db-shm"];

	for (const file of files) {
		try {
			const absPath = path.join(dir, file);
			if (existsSync(absPath)) {
				rmSync(absPath, { force: true });
				console.log(`[legacy-db-cleanup] removed ${absPath}`);
			}
		} catch (e: unknown) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EACCES" || code === "EBUSY" || code === "EPERM") continue;
			// ENOENT handled by existsSync; other unexpected errors silently ignored.
		}
	}
}
