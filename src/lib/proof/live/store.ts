/**
 * Live agent collaboration store.
 *
 * Control-plane only: it carries a human's intent (selected block + instruction)
 * to an attached agent and tracks the session/request lifecycle. It never writes
 * documents. The actual edit lands through the existing tier-2 commit path
 * (`applyOps` via POST /api/agent/files/<path>) with a deterministic idempotency
 * key `live:<requestId>` and provenance correlation `inResponseTo: "live:<requestId>"`.
 *
 * DB: ~/.wiki-viewer/live.db (WAL, separate from auth.db / shared.db), following
 * the same lazy-singleton pattern as src/lib/shared-docs/db.ts.
 */
import Database from "@/lib/sqlite";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** An agent counts as attached if it polled within this window (ms). */
// Held polls refresh presence every ~400ms and re-poll sub-second, so a short
// TTL never false-negatives an actively attending agent but flips a stopped
// agent to "not listening" quickly. The client adds a small grace window on top
// to avoid flicker during the agent's own chat turns.
export const PRESENCE_TTL_MS = 8_000;

export type RequestKind =
	| "generate"
	| "steer"
	| "accept"
	| "discard"
	| "exit"
	// Web-tweak kinds (impeccable-grade web live collab). web.tweak asks the
	// agent to produce a preview transaction (DOM preview ops + candidate source
	// patch + base hashes). web.accept / web.discard reference a previewId.
	| "web.tweak"
	// web.tweak.variants asks the agent to return N candidate options for ONE
	// target in a single reply; the human switches in-frame and accepts one.
	| "web.tweak.variants"
	| "web.accept"
	| "web.discard";
export type RequestState =
	| "pending"
	| "delivered"
	| "working"
	| "resolved"
	| "stale"
	| "error";
// "completed" = agent finished the turn (channel freed); the proof-span is left
// in the doc for optional human review. "accepted"/"reverted" record an explicit
// human review decision on that produced content.
export type RequestOutcome = "completed" | "accepted" | "reverted";

export interface LiveSession {
	id: string;
	workspaceId: string;
	agentId: string | null;
	state: "open" | "closed";
	createdAt: number;
	agentLastSeen: number | null;
}

/** One instruction item within a batch "Send to agent" run. */
export interface LiveInstructionItem {
	instructionId: string;
	blockRef: string | null;
	baseRevision: number | null;
	instruction: string;
	selectionText?: string | null;
	selectionStart?: number | null;
	selectionEnd?: number | null;
}

export interface LiveRequest {
	id: string;
	sessionId: string;
	workspaceId: string;
	path: string;
	blockRef: string | null;
	baseRevision: number | null;
	kind: RequestKind;
	instruction: string | null;
	selectionText: string | null;
	selectionStart: number | null;
	selectionEnd: number | null;
	/** Batch payload: N instruction items dispatched as one run. Null for legacy single requests. */
	items: LiveInstructionItem[] | null;
	/** Correlation id stamped on results produced by this run. */
	runId: string | null;
	state: RequestState;
	outcome: RequestOutcome | null;
	seq: number;
	createdAt: number;
	deliveredAt: number | null;
	resolvedAt: number | null;
}

const NON_TERMINAL: RequestState[] = ["pending", "delivered", "working"];

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
	if (_db) return _db;
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	_db = new Database(path.join(dir, "live.db"));
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");
	_db.exec(`
		CREATE TABLE IF NOT EXISTS live_session (
			id              TEXT PRIMARY KEY,
			workspace_id    TEXT NOT NULL,
			agent_id        TEXT,
			state           TEXT NOT NULL,
			created_at      INTEGER NOT NULL,
			agent_last_seen INTEGER
		);
		CREATE INDEX IF NOT EXISTS live_session_ws_idx ON live_session(workspace_id, state);

		CREATE TABLE IF NOT EXISTS live_request (
			id            TEXT PRIMARY KEY,
			session_id    TEXT NOT NULL,
			workspace_id  TEXT NOT NULL,
			path          TEXT NOT NULL,
			block_ref     TEXT,
			base_revision INTEGER,
			kind          TEXT NOT NULL,
			instruction   TEXT,
			selection_text  TEXT,
			selection_start INTEGER,
			selection_end   INTEGER,
			items         TEXT,
			run_id        TEXT,
			state         TEXT NOT NULL,
			outcome       TEXT,
			seq           INTEGER NOT NULL,
			created_at    INTEGER NOT NULL,
			delivered_at  INTEGER,
			resolved_at   INTEGER
		);
		CREATE INDEX IF NOT EXISTS live_request_session_idx ON live_request(session_id, state);
		CREATE INDEX IF NOT EXISTS live_request_ws_seq_idx ON live_request(workspace_id, seq);
	`);
	// Additive migration: existing databases won't gain columns from
	// CREATE TABLE IF NOT EXISTS. Add the precise-pointing columns if absent.
	const cols = _db
		.prepare(`PRAGMA table_info(live_request)`)
		.all() as Array<{ name: string }>;
	const have = new Set(cols.map((c) => c.name));
	const additive: Array<[string, string]> = [
		["selection_text", "TEXT"],
		["selection_start", "INTEGER"],
		["selection_end", "INTEGER"],
		["items", "TEXT"],
		["run_id", "TEXT"],
	];
	for (const [name, type] of additive) {
		if (have.has(name)) continue;
		try {
			_db.exec(`ALTER TABLE live_request ADD COLUMN ${name} ${type}`);
		} catch {
			/* column added concurrently; harmless */
		}
	}
	return _db;
}

// For tests: reset the singleton so a fresh HOME picks up a fresh db.
export function _resetForTests(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

function genId(prefix: string): string {
	return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

interface SessionRow {
	id: string;
	workspace_id: string;
	agent_id: string | null;
	state: string;
	created_at: number;
	agent_last_seen: number | null;
}

interface RequestRow {
	id: string;
	session_id: string;
	workspace_id: string;
	path: string;
	block_ref: string | null;
	base_revision: number | null;
	kind: string;
	instruction: string | null;
	selection_text: string | null;
	selection_start: number | null;
	selection_end: number | null;
	items: string | null;
	run_id: string | null;
	state: string;
	outcome: string | null;
	seq: number;
	created_at: number;
	delivered_at: number | null;
	resolved_at: number | null;
}

function toSession(r: SessionRow): LiveSession {
	return {
		id: r.id,
		workspaceId: r.workspace_id,
		agentId: r.agent_id,
		state: r.state as LiveSession["state"],
		createdAt: r.created_at,
		agentLastSeen: r.agent_last_seen,
	};
}

function toRequest(r: RequestRow): LiveRequest {
	return {
		id: r.id,
		sessionId: r.session_id,
		workspaceId: r.workspace_id,
		path: r.path,
		blockRef: r.block_ref,
		baseRevision: r.base_revision,
		kind: r.kind as RequestKind,
		instruction: r.instruction,
		selectionText: r.selection_text,
		selectionStart: r.selection_start,
		selectionEnd: r.selection_end,
		items: r.items ? (JSON.parse(r.items) as LiveInstructionItem[]) : null,
		runId: r.run_id,
		state: r.state as RequestState,
		outcome: (r.outcome as RequestOutcome | null) ?? null,
		seq: r.seq,
		createdAt: r.created_at,
		deliveredAt: r.delivered_at,
		resolvedAt: r.resolved_at,
	};
}

/** Latest open session for a workspace, if any. */
export function latestOpenSession(workspaceId: string): LiveSession | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM live_session WHERE workspace_id = ? AND state = 'open'
			 ORDER BY created_at DESC LIMIT 1`,
		)
		.get(workspaceId) as SessionRow | undefined;
	return row ? toSession(row) : null;
}

export function getSession(sessionId: string): LiveSession | null {
	const row = getDb()
		.prepare(`SELECT * FROM live_session WHERE id = ?`)
		.get(sessionId) as SessionRow | undefined;
	return row ? toSession(row) : null;
}

/**
 * Attach an agent to the workspace's live session, creating one if none is open.
 * Idempotent per agent+workspace: reuses the latest open session.
 */
export function attachAgent(workspaceId: string, agentId: string): LiveSession {
	const db = getDb();
	const now = Date.now();
	const existing = latestOpenSession(workspaceId);
	// Claim the existing session only if it is unowned, owned by this same agent,
	// or its previous agent's presence expired. Never steal a live session from a
	// different attached agent — create a fresh session so ownership stays stable.
	if (existing) {
		const claimable =
			!existing.agentId ||
			existing.agentId === agentId ||
			existing.agentLastSeen === null ||
			now - existing.agentLastSeen > PRESENCE_TTL_MS;
		if (claimable) {
			db.prepare(
				`UPDATE live_session SET agent_id = ?, agent_last_seen = ? WHERE id = ?`,
			).run(agentId, now, existing.id);
			return { ...existing, agentId, agentLastSeen: now };
		}
	}
	const id = genId("ls");
	db.prepare(
		`INSERT INTO live_session (id, workspace_id, agent_id, state, created_at, agent_last_seen)
		 VALUES (?, ?, ?, 'open', ?, ?)`,
	).run(id, workspaceId, agentId, now, now);
	return {
		id,
		workspaceId,
		agentId,
		state: "open",
		createdAt: now,
		agentLastSeen: now,
	};
}

/**
 * Get the workspace's open session, creating one with no attached agent if none
 * exists. Used by the human dispatch path so a request can be enqueued before an
 * agent has attached; the agent's attach reuses this session.
 */
export function getOrCreateSession(workspaceId: string): LiveSession {
	const existing = latestOpenSession(workspaceId);
	if (existing) return existing;
	const db = getDb();
	const id = genId("ls");
	const now = Date.now();
	db.prepare(
		`INSERT INTO live_session (id, workspace_id, agent_id, state, created_at, agent_last_seen)
		 VALUES (?, ?, NULL, 'open', ?, NULL)`,
	).run(id, workspaceId, now);
	return {
		id,
		workspaceId,
		agentId: null,
		state: "open",
		createdAt: now,
		agentLastSeen: null,
	};
}

/** Refresh presence; the held long-poll calls this each tick. */
export function touchAgent(sessionId: string): void {
	getDb()
		.prepare(`UPDATE live_session SET agent_last_seen = ? WHERE id = ?`)
		.run(Date.now(), sessionId);
}

export function closeSession(sessionId: string): void {
	getDb()
		.prepare(`UPDATE live_session SET state = 'closed' WHERE id = ?`)
		.run(sessionId);
}

/** True if the session has an agent that polled within the presence window. */
export function isAttached(session: LiveSession | null): boolean {
	if (!session || session.state !== "open" || !session.agentId) return false;
	if (session.agentLastSeen === null) return false;
	return Date.now() - session.agentLastSeen <= PRESENCE_TTL_MS;
}

export interface EnqueueInput {
	sessionId: string;
	workspaceId: string;
	path: string;
	blockRef?: string | null;
	baseRevision?: number | null;
	kind: RequestKind;
	instruction?: string | null;
	selectionText?: string | null;
	selectionStart?: number | null;
	selectionEnd?: number | null;
	/** Batch payload for a run. When set, `runId` should also be provided. */
	items?: LiveInstructionItem[] | null;
	runId?: string | null;
}

export interface EnqueueResult {
	ok: true;
	request: LiveRequest;
}
export interface EnqueueConflict {
	ok: false;
	code: "OUTSTANDING_REQUEST";
	request: LiveRequest;
}

/**
 * Enqueue a live request. For generate/steer, enforce one-outstanding-per-session:
 * reject if the session already has a non-terminal request. accept/discard/exit are
 * lifecycle notifications and are always allowed.
 */
export function enqueueRequest(
	input: EnqueueInput,
): EnqueueResult | EnqueueConflict {
	const db = getDb();
	// BEGIN IMMEDIATE takes the WAL write lock up front so the outstanding-check,
	// MAX(seq) read, and insert are atomic across concurrent route workers sharing
	// live.db.
	let inTxn = false;
	try {
		db.exec("BEGIN IMMEDIATE");
		inTxn = true;
	} catch {
		inTxn = false;
	}
	try {
		if (input.kind === "generate" || input.kind === "steer") {
			const outstanding = db
				.prepare(
					`SELECT * FROM live_request
					 WHERE session_id = ? AND state IN ('pending','delivered','working')
					 ORDER BY seq DESC LIMIT 1`,
				)
				.get(input.sessionId) as RequestRow | undefined;
			if (outstanding) {
				if (inTxn) db.exec("COMMIT");
				return {
					ok: false,
					code: "OUTSTANDING_REQUEST",
					request: toRequest(outstanding),
				};
			}
		}

		const seqRow = db
			.prepare(
				`SELECT COALESCE(MAX(seq), 0) AS m FROM live_request WHERE workspace_id = ?`,
			)
			.get(input.workspaceId) as { m: number };
		const seq = seqRow.m + 1;
		const id = genId("lr");
		const now = Date.now();

		db.prepare(
			`INSERT INTO live_request
			 (id, session_id, workspace_id, path, block_ref, base_revision, kind, instruction, selection_text, selection_start, selection_end, items, run_id, state, outcome, seq, created_at, delivered_at, resolved_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL, NULL)`,
		).run(
			id,
			input.sessionId,
			input.workspaceId,
			input.path,
			input.blockRef ?? null,
			input.baseRevision ?? null,
			input.kind,
			input.instruction ?? null,
			input.selectionText ?? null,
			input.selectionStart ?? null,
			input.selectionEnd ?? null,
			input.items ? JSON.stringify(input.items) : null,
			input.runId ?? null,
			seq,
			now,
		);
		if (inTxn) db.exec("COMMIT");
		return { ok: true, request: getRequest(id)! };
	} catch (e) {
		if (inTxn) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* ignore */
			}
		}
		throw e;
	}
}

export function getRequest(requestId: string): LiveRequest | null {
	const row = getDb()
		.prepare(`SELECT * FROM live_request WHERE id = ?`)
		.get(requestId) as RequestRow | undefined;
	return row ? toRequest(row) : null;
}

/**
 * Next request the agent should handle for this session with seq greater than
 * `afterSeq`, ordered by seq. Includes `delivered` (not only `pending`) so a
 * request delivered to an agent that then crashed before replying is redelivered
 * on reconnect. The idempotency key is derived from the request id, so
 * reprocessing a redelivered request is safe. Once the agent replies (state
 * leaves 'delivered'/'pending'), it is no longer redelivered.
 */
export function nextDeliverableRequest(
	sessionId: string,
	afterSeq: number,
): LiveRequest | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM live_request
			 WHERE session_id = ? AND state IN ('pending','delivered') AND seq > ?
			 ORDER BY seq ASC LIMIT 1`,
		)
		.get(sessionId, afterSeq) as RequestRow | undefined;
	return row ? toRequest(row) : null;
}

export function markDelivered(requestId: string): void {
	getDb()
		.prepare(
			`UPDATE live_request SET state = 'delivered', delivered_at = ? WHERE id = ?`,
		)
		.run(Date.now(), requestId);
}

export function markState(
	requestId: string,
	state: RequestState,
	outcome?: RequestOutcome | null,
): void {
	const terminal = state === "resolved" || state === "stale" || state === "error";
	getDb()
		.prepare(
			`UPDATE live_request SET state = ?, outcome = ?, resolved_at = ? WHERE id = ?`,
		)
		.run(
			state,
			outcome ?? null,
			terminal ? Date.now() : null,
			requestId,
		);
}

/** Most recent request for a session (for status display). */
export function latestRequest(sessionId: string): LiveRequest | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM live_request WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
		)
		.get(sessionId) as RequestRow | undefined;
	return row ? toRequest(row) : null;
}

export { NON_TERMINAL };
