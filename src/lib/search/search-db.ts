/**
 * Search database lifecycle.
 *
 * This database stores workspace file metadata and the wiki-link graph.
 * It does NOT store file content — content search is served by ripgrep.
 * The database is rebuildable from the filesystem at any time; deleting it
 * only triggers a background rescan on next access.
 *
 * Schema version guard: on open, PRAGMA user_version is checked. If it differs
 * from SCHEMA_VERSION the file is deleted and rebuilt — this handles the
 * one-off migration from the FTS5 era and any future schema bumps.
 */
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync, rmSync, statSync } from "node:fs";

export const SCHEMA_VERSION = 2;

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

let _db: InstanceType<typeof Database> | null = null;

export function getSearchDb(): InstanceType<typeof Database> {
	if (_db) return _db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	const dbPath = path.join(dir, "search.db");

	// Open temporarily to check the schema version.
	let needsRebuild = false;
	let oldBytes = 0;

	try {
		const existing = new Database(dbPath);
		try {
			const ver = existing.pragma("user_version", { simple: true }) as number;
			if (ver !== SCHEMA_VERSION) {
				needsRebuild = true;
			}
		} finally {
			existing.close();
		}
	} catch {
		// Database file is corrupt or not a valid SQLite file.
		needsRebuild = true;
		// Close may not be possible; the Database constructor itself threw.
	}

	if (needsRebuild) {
		try { oldBytes = statSync(dbPath).size; } catch { /* ignore */ }
		try { oldBytes += statSync(dbPath + "-wal").size; } catch { /* ignore */ }
		try { oldBytes += statSync(dbPath + "-shm").size; } catch { /* ignore */ }
	}

	if (needsRebuild) {
		try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
		try { rmSync(dbPath + "-wal", { force: true }); } catch { /* ignore */ }
		try { rmSync(dbPath + "-shm", { force: true }); } catch { /* ignore */ }
		const mb = (oldBytes / (1024 * 1024)).toFixed(1);
		console.log(`[search-db] schema-v${SCHEMA_VERSION} migration: deleted old search.db (${mb} MB), rebuilding`);
	}

	_db = new Database(dbPath);

	// Pragmas for a fresh or current-version database.
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");
	_db.pragma("temp_store = MEMORY");
	_db.pragma("mmap_size = 33554432"); // 32 MiB (down from 128 MiB — body index gone)
	_db.pragma("auto_vacuum = INCREMENTAL");

	// Belt-and-braces: drop any leftover FTS5 tables.
	_db.exec(`DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS docs_meta;`);

	// New schema.
	_db.exec(`
		CREATE TABLE IF NOT EXISTS files (
			ws         TEXT NOT NULL,
			path       TEXT NOT NULL,
			size       INTEGER NOT NULL,
			mtime_ns   INTEGER NOT NULL,
			sha        TEXT NOT NULL DEFAULT '',
			slug       TEXT,
			indexed_at TEXT NOT NULL,
			PRIMARY KEY (ws, path)
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS files_ws_slug_idx ON files(ws, slug);

		CREATE TABLE IF NOT EXISTS links (
			ws          TEXT NOT NULL,
			src_path    TEXT NOT NULL,
			target_slug TEXT NOT NULL,
			line        INTEGER NOT NULL,
			context     TEXT NOT NULL,
			PRIMARY KEY (ws, src_path, target_slug)
		) WITHOUT ROWID;
		CREATE INDEX IF NOT EXISTS links_ws_target_idx ON links(ws, target_slug);
	`);

	_db.pragma("user_version = " + SCHEMA_VERSION);

	return _db;
}

/** Return the absolute path to search.db (test hook). */
export function _searchDbPath(): string {
	return path.join(dataDir(), "search.db");
}

/** Reset cached DB handle. Used by tests to pick up a new HOME. */
export function _resetSearchDb(): void {
	try { _db?.close(); } catch { /* ignore */ }
	_db = null;
}
