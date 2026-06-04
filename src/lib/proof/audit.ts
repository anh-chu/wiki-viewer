/**
 * Minimal durable audit log for raw-fs mutations (Tier 1).
 *
 * Uses the same ~/.wiki-viewer/auth.db already opened by better-auth.
 * Table: agent_fs_audit
 *
 * For .md files the sidecar event covers provenance; this covers ALL types.
 */
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

// Lazily initialised so tests can set HOME before first import.
let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
	if (_db) return _db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	const dbPath = path.join(dir, "auth.db");
	_db = new Database(dbPath);
	_db.pragma("journal_mode = WAL");
	_db.exec(`
		CREATE TABLE IF NOT EXISTS agent_fs_audit (
			id           INTEGER PRIMARY KEY AUTOINCREMENT,
			agent_id     TEXT NOT NULL,
			op           TEXT NOT NULL,
			path         TEXT NOT NULL,
			old_sha      TEXT,
			new_sha      TEXT,
			forced       INTEGER NOT NULL DEFAULT 0,
			at           TEXT NOT NULL,
			workspace_id TEXT
		)
	`);
	// Tolerant migration for existing DBs that lack the workspace_id column.
	try {
		_db.exec(`ALTER TABLE agent_fs_audit ADD COLUMN workspace_id TEXT`);
	} catch {
		// Column already exists — ignore.
	}
	return _db;
}

export interface AuditRow {
	agentId: string;
	op: string;
	path: string;
	oldSha?: string;
	newSha?: string;
	forced?: boolean;
	workspaceId?: string;
}

/**
 * Write one audit row synchronously (SQLite sync is fine here — it's a WAL journal append).
 * Fire-and-forget: never throws; logs to stderr on error.
 */
export function writeAuditRow(row: AuditRow): void {
	try {
		const db = getDb();
		db.prepare(
			`INSERT INTO agent_fs_audit (agent_id, op, path, old_sha, new_sha, forced, at, workspace_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			row.agentId,
			row.op,
			row.path,
			row.oldSha ?? null,
			row.newSha ?? null,
			row.forced ? 1 : 0,
			new Date().toISOString(),
			row.workspaceId ?? null,
		);
	} catch (e) {
		console.error("[agent-fs audit] write failed:", e);
	}
}

/** Reset cached DB handle (used by tests to pick up new HOME). */
export function _resetAuditDb(): void {
	_db = null;
}
