/**
 * Search database lifecycle.
 *
 * Separate from auth.db: FTS5 shadow tables would pollute the auth schema and
 * better-auth's migrator could misidentify them. search.db is rebuildable from
 * the filesystem at any time -- deleting it only triggers a rescan on next access.
 *
 * Mirrors src/lib/proof/audit.ts structure.
 */
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

let _db: InstanceType<typeof Database> | null = null;

export function getSearchDb(): InstanceType<typeof Database> {
	if (_db) return _db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	_db = new Database(path.join(dir, "search.db"));
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");
	_db.pragma("temp_store = MEMORY");
	_db.pragma("mmap_size = 134217728"); // 128 MiB
	_db.exec(`
		CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
			ws         UNINDEXED,
			path       UNINDEXED,
			name,
			frontmatter,
			body,
			tokenize = 'porter unicode61 remove_diacritics 2'
		);
		CREATE TABLE IF NOT EXISTS docs_meta (
			ws         TEXT NOT NULL,
			path       TEXT NOT NULL,
			size       INTEGER NOT NULL,
			mtime_ns   INTEGER NOT NULL,
			sha        TEXT NOT NULL,
			indexed_at TEXT NOT NULL,
			PRIMARY KEY (ws, path)
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS docs_meta_ws_idx ON docs_meta(ws);
	`);
	return _db;
}

/** Reset cached DB handle. Used by tests to pick up a new HOME. */
export function _resetSearchDb(): void {
	try { _db?.close(); } catch { /* ignore */ }
	_db = null;
}
