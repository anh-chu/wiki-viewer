/**
 * Shared docs DB — stores share links for public read-only access.
 *
 * Each share link references a (workspaceId, filePath) pair. The link
 * can optionally be password-protected and/or time-limited.
 *
 * DB: ~/.wiki-viewer/shared.db (WAL mode, separate from auth.db and search.db).
 */
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export interface SharedDoc {
	id: string;
	workspaceId: string;
	filePath: string;
	token: string;
	passwordHash: string | null;
	expiresAt: string | null;
	createdBy: string;
	createdAt: string;
	viewCount: number;
	isRevoked: boolean;
}

export interface CreateSharedDocInput {
	workspaceId: string;
	filePath: string;
	password?: string;
	expiresAt?: string; // ISO date string, e.g. "2026-07-10T00:00:00Z"
	createdBy: string;
}

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
	if (_db) return _db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	_db = new Database(path.join(dir, "shared.db"));
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");
	_db.exec(`
		CREATE TABLE IF NOT EXISTS shared_docs (
			id            TEXT PRIMARY KEY,
			workspace_id  TEXT NOT NULL,
			file_path     TEXT NOT NULL,
			token         TEXT NOT NULL UNIQUE,
			password_hash TEXT,
			expires_at    TEXT,
			created_by    TEXT NOT NULL,
			created_at    TEXT NOT NULL,
			view_count    INTEGER NOT NULL DEFAULT 0,
			is_revoked    INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS shared_docs_token_idx ON shared_docs(token);
		CREATE INDEX IF NOT EXISTS shared_docs_file_idx ON shared_docs(workspace_id, file_path);
	`);
	return _db;
}

export function createShare(input: CreateSharedDocInput): SharedDoc {
	const db = getDb();
	const id = "shr_" + randomBytes(8).toString("base64url");
	const token = randomBytes(16).toString("base64url");
	const passwordHash = input.password ? hashPassword(input.password) : null;

	const shared: SharedDoc = {
		id,
		workspaceId: input.workspaceId,
		filePath: input.filePath,
		token,
		passwordHash,
		expiresAt: input.expiresAt ?? null,
		createdBy: input.createdBy,
		createdAt: new Date().toISOString(),
		viewCount: 0,
		isRevoked: false,
	};

	const dbValues = {
		...shared,
		isRevoked: shared.isRevoked ? 1 : 0,
	};

	db.prepare(
		`INSERT INTO shared_docs
		 (id, workspace_id, file_path, token, password_hash, expires_at, created_by, created_at, view_count, is_revoked)
		 VALUES (@id, @workspaceId, @filePath, @token, @passwordHash, @expiresAt, @createdBy, @createdAt, @viewCount, @isRevoked)`,
	).run(dbValues);
	return shared;
}

type DbRow = Record<string, unknown>;

function rowToShare(row: DbRow): SharedDoc {
	return {
		id: row.id as string,
		workspaceId: row.workspace_id as string,
		filePath: row.file_path as string,
		token: row.token as string,
		passwordHash: (row.password_hash as string | null) ?? null,
		expiresAt: (row.expires_at as string | null) ?? null,
		createdBy: row.created_by as string,
		createdAt: row.created_at as string,
		viewCount: (row.view_count as number) ?? 0,
		isRevoked: (row.is_revoked as number) === 1,
	};
}

export function getShareByToken(token: string): SharedDoc | null {
	const db = getDb();
	const row = db.prepare("SELECT * FROM shared_docs WHERE token = ?").get(token) as
		| DbRow
		| undefined;
	return row ? rowToShare(row) : null;
}

export function listSharesForFile(
	workspaceId: string,
	filePath: string,
): SharedDoc[] {
	const db = getDb();
	const rows = db
		.prepare(
			"SELECT * FROM shared_docs WHERE workspace_id = ? AND file_path = ? AND is_revoked = 0 ORDER BY created_at DESC",
		)
		.all(workspaceId, filePath) as DbRow[];
	return rows.map(rowToShare);
}

export function revokeShare(id: string): void {
	const db = getDb();
	db.prepare("UPDATE shared_docs SET is_revoked = 1 WHERE id = ?").run(id);
}

export function incrementViewCount(token: string): void {
	const db = getDb();
	db.prepare(
		"UPDATE shared_docs SET view_count = view_count + 1 WHERE token = ?",
	).run(token);
}

export function isExpired(share: SharedDoc): boolean {
	if (!share.expiresAt) return false;
	return new Date(share.expiresAt) < new Date();
}

function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(password, salt, 64).toString("hex");
	return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	const [salt, hash] = stored.split(":");
	const expected = scryptSync(password, salt, 64);
	const actual = Buffer.from(hash, "hex");
	if (expected.length !== actual.length) return false;
	return timingSafeEqual(expected, actual);
}

/** Reset cached DB handle (used by tests). */
export function _resetSharedDb(): void {
	try {
		_db?.close();
	} catch {
		/* ignore */
	}
	_db = null;
}
