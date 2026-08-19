import Database from "@/lib/sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ScaffoldState = "open" | "ready" | "accepted" | "discarded" | "closed";

export interface LiveWebScaffold {
	id: string;
	sessionId: string;
	workspaceId: string;
	relPath: string;
	originalSource: string;
	diskBaseHash: string;
	scaffold: string | null;
	scaffoldHash: string | null;
	chosenVariantId: string | null;
	paramValues: Record<string, string | number>;
	state: ScaffoldState;
	createdAt: number;
	updatedAt: number;
	closedAt: number | null;
}

export interface CreateScaffoldInput {
	sessionId: string;
	workspaceId: string;
	relPath: string;
	originalSource: string;
	diskBaseHash: string;
	scaffold?: string | null;
	chosenVariantId?: string | null;
	paramValues?: Record<string, string | number>;
	state?: ScaffoldState;
}

interface ScaffoldRow {
	id: string;
	session_id: string;
	workspace_id: string;
	rel_path: string;
	original_source: string;
	disk_base_hash: string;
	scaffold: string | null;
	scaffold_hash: string | null;
	chosen_variant_id: string | null;
	param_values: string;
	state: string;
	created_at: number;
	updated_at: number;
	closed_at: number | null;
}

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

let db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
	if (db) return db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	db = new Database(path.join(dir, "live.db"));
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS live_web_scaffold (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			rel_path TEXT NOT NULL,
			original_source TEXT NOT NULL,
			disk_base_hash TEXT NOT NULL,
			scaffold TEXT,
			scaffold_hash TEXT,
			chosen_variant_id TEXT,
			param_values TEXT NOT NULL,
			state TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			closed_at INTEGER
		);
		CREATE INDEX IF NOT EXISTS live_web_scaffold_ws_idx ON live_web_scaffold(workspace_id, rel_path, created_at);
		CREATE TABLE IF NOT EXISTS live_web_event_map (
			engine_event_id TEXT PRIMARY KEY,
			live_request_id TEXT NOT NULL,
			scaffold_id TEXT NOT NULL,
			reply TEXT,
			created_at INTEGER NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS live_web_event_request_idx ON live_web_event_map(live_request_id);
	`);
	return db;
}

function id(): string {
	return `lws_${randomBytes(9).toString("base64url")}`;
}

function toScaffold(row: ScaffoldRow): LiveWebScaffold {
	let paramValues: Record<string, string | number> = {};
	try {
		const parsed = JSON.parse(row.param_values) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			paramValues = parsed as Record<string, string | number>;
		}
	} catch {
		/* Corrupt optional metadata must not prevent recovery of the scaffold. */
	}
	return {
		id: row.id,
		sessionId: row.session_id,
		workspaceId: row.workspace_id,
		relPath: row.rel_path,
		originalSource: row.original_source,
		diskBaseHash: row.disk_base_hash,
		scaffold: row.scaffold,
		scaffoldHash: row.scaffold_hash,
		chosenVariantId: row.chosen_variant_id,
		paramValues,
		state: row.state as ScaffoldState,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		closedAt: row.closed_at,
	};
}

export function hashScaffold(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

export function createScaffold(input: CreateScaffoldInput): LiveWebScaffold {
	const now = Date.now();
	const scaffoldHash = input.scaffold === null || input.scaffold === undefined ? null : hashScaffold(input.scaffold);
	const scaffoldId = id();
	getDb().prepare(`
		INSERT INTO live_web_scaffold
		(id, session_id, workspace_id, rel_path, original_source, disk_base_hash, scaffold, scaffold_hash,
		 chosen_variant_id, param_values, state, created_at, updated_at, closed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
	`).run(
		scaffoldId,
		input.sessionId,
		input.workspaceId,
		input.relPath,
		input.originalSource,
		input.diskBaseHash,
		input.scaffold ?? null,
		scaffoldHash,
		input.chosenVariantId ?? null,
		JSON.stringify(input.paramValues ?? {}),
		input.state ?? (input.scaffold ? "ready" : "open"),
		now,
		now,
	);
	return getScaffold(scaffoldId)!;
}

export function getScaffold(scaffoldId: string): LiveWebScaffold | null {
	const row = getDb().prepare(`SELECT * FROM live_web_scaffold WHERE id = ?`).get(scaffoldId) as ScaffoldRow | undefined;
	return row ? toScaffold(row) : null;
}

export function getLatestScaffold(workspaceId: string, relPath: string): LiveWebScaffold | null {
	const row = getDb().prepare(`
		SELECT * FROM live_web_scaffold
		WHERE workspace_id = ? AND rel_path = ? AND state NOT IN ('accepted', 'discarded', 'closed')
		ORDER BY created_at DESC LIMIT 1
	`).get(workspaceId, relPath) as ScaffoldRow | undefined;
	return row ? toScaffold(row) : null;
}

export function updateScaffold(
	scaffoldId: string,
	patch: Partial<Pick<LiveWebScaffold, "scaffold" | "chosenVariantId" | "paramValues" | "state">>,
): LiveWebScaffold | null {
	const current = getScaffold(scaffoldId);
	if (!current) return null;
	const scaffold = patch.scaffold === undefined ? current.scaffold : patch.scaffold;
	const now = Date.now();
	getDb().prepare(`
		UPDATE live_web_scaffold SET scaffold = ?, scaffold_hash = ?, chosen_variant_id = ?, param_values = ?, state = ?, updated_at = ?
		WHERE id = ?
	`).run(
		scaffold,
		scaffold === null ? null : hashScaffold(scaffold),
		patch.chosenVariantId === undefined ? current.chosenVariantId : patch.chosenVariantId,
		JSON.stringify(patch.paramValues === undefined ? current.paramValues : patch.paramValues),
		patch.state ?? current.state,
		now,
		scaffoldId,
	);
	return getScaffold(scaffoldId);
}

export function closeScaffold(
	scaffoldId: string,
	state: "accepted" | "discarded" | "closed" = "closed",
): LiveWebScaffold | null {
	const now = Date.now();
	getDb().prepare(`UPDATE live_web_scaffold SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?`).run(state, now, now, scaffoldId);
	return getScaffold(scaffoldId);
}

export interface EngineEventMapping {
	engineEventId: string;
	liveRequestId: string;
	scaffoldId: string;
	reply: Record<string, unknown> | null;
}

interface MappingRow {
	engine_event_id: string;
	live_request_id: string;
	scaffold_id: string;
	reply: string | null;
}

function toMapping(row: MappingRow): EngineEventMapping {
	let reply: Record<string, unknown> | null = null;
	if (row.reply) {
		try { reply = JSON.parse(row.reply) as Record<string, unknown>; } catch { reply = null; }
	}
	return { engineEventId: row.engine_event_id, liveRequestId: row.live_request_id, scaffoldId: row.scaffold_id, reply };
}

export function mapEngineEvent(engineEventId: string, liveRequestId: string, scaffoldId: string): EngineEventMapping {
	const existing = getEngineEventMapping(engineEventId);
	if (existing) return existing;
	try {
		getDb().prepare(`INSERT INTO live_web_event_map (engine_event_id, live_request_id, scaffold_id, reply, created_at) VALUES (?, ?, ?, NULL, ?)`).run(engineEventId, liveRequestId, scaffoldId, Date.now());
	} catch {
		/* Another loop may have won the idempotency race. */
	}
	return getEngineEventMapping(engineEventId)!;
}

export function getEngineEventMapping(engineEventId: string): EngineEventMapping | null {
	const row = getDb().prepare(`SELECT * FROM live_web_event_map WHERE engine_event_id = ?`).get(engineEventId) as MappingRow | undefined;
	return row ? toMapping(row) : null;
}

export function getEngineEventByRequest(liveRequestId: string): EngineEventMapping | null {
	const row = getDb().prepare(`SELECT * FROM live_web_event_map WHERE live_request_id = ?`).get(liveRequestId) as MappingRow | undefined;
	return row ? toMapping(row) : null;
}

export function saveEngineReply(engineEventId: string, reply: Record<string, unknown>): void {
	getDb().prepare(`UPDATE live_web_event_map SET reply = ? WHERE engine_event_id = ?`).run(JSON.stringify(reply), engineEventId);
}

export function _resetForTests(): void {
	if (db) { db.close(); db = null; }
}

export { getDb };
