/**
 * Web-tweak preview transaction store.
 *
 * A web tweak is NOT identified by a CSS selector alone. Every tweak is a
 * versioned preview transaction keyed by a server-issued `previewId`:
 *
 *   previewId
 *     -> selected DOM fingerprint (selector, tag, snippet, text)
 *     -> domPreviewOps            (ephemeral, applied in-frame; data-only)
 *     -> candidateSourcePatch     (immutable; the exact edit accept will write)
 *     -> baseFiles[]              ({ path, sha256 }) the candidate was derived against
 *     -> status
 *
 * `web.tweak` produces domPreviewOps AND candidateSourcePatch at the same time.
 * `web.accept` commits candidateSourcePatch VERBATIM iff every baseFiles[].sha256
 * still matches on disk; otherwise the transaction is `invalidated` and nothing
 * is written. Accept never re-localizes or re-synthesizes. That binding is what
 * makes this a reviewed variant rather than a mere visual proposal.
 *
 * Control-plane only: this store never writes documents. The source write on
 * accept happens through the tier-1 raw-fs path.
 *
 * DB: reuses ~/.wiki-viewer/live.db (same file as the live session/request
 * store) via the shared sqlite singleton pattern.
 */
import Database from "@/lib/sqlite";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { DomOp } from "./protocol";

export type PreviewStatus =
	| "requested"
	| "preview-ready"
	| "resolving"
	| "accepted"
	| "discarded"
	| "invalidated";

/** One file the candidate patch was derived against, pinned by content hash. */
export interface BaseFile {
	path: string;
	sha256: string;
}

/**
 * The immutable source edit accept will commit. A candidate is a set of
 * whole-file replacements (path -> new content). This is intentionally simple
 * and deterministic: accept writes exactly these files iff their base hashes
 * still match. `null` candidate means "visual only, not acceptable".
 */
export interface CandidateSourcePatch {
	files: Array<{ path: string; content: string }>;
	summary: string;
}

export interface PreviewTransaction {
	id: string;
	sessionId: string;
	workspaceId: string;
	requestId: string | null;
	path: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	note: string | null;
	domPreviewOps: DomOp[] | null;
	candidateSourcePatch: CandidateSourcePatch | null;
	baseFiles: BaseFile[];
	status: PreviewStatus;
	createdAt: number;
	resolvedAt: number | null;
}

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
		CREATE TABLE IF NOT EXISTS web_preview (
			id               TEXT PRIMARY KEY,
			session_id       TEXT NOT NULL,
			workspace_id     TEXT NOT NULL,
			request_id       TEXT,
			path             TEXT NOT NULL,
			selector         TEXT NOT NULL,
			tag              TEXT NOT NULL,
			snippet          TEXT NOT NULL,
			text             TEXT NOT NULL,
			note             TEXT,
			dom_preview_ops  TEXT,
			candidate_patch  TEXT,
			base_files       TEXT NOT NULL,
			status           TEXT NOT NULL,
			created_at       INTEGER NOT NULL,
			resolved_at      INTEGER
		);
		CREATE INDEX IF NOT EXISTS web_preview_ws_idx ON web_preview(workspace_id, status);
		CREATE INDEX IF NOT EXISTS web_preview_session_idx ON web_preview(session_id, created_at);
	`);
	return _db;
}

export function _resetForTests(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

function genId(prefix: string): string {
	return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

interface Row {
	id: string;
	session_id: string;
	workspace_id: string;
	request_id: string | null;
	path: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	note: string | null;
	dom_preview_ops: string | null;
	candidate_patch: string | null;
	base_files: string;
	status: string;
	created_at: number;
	resolved_at: number | null;
}

function toTxn(r: Row): PreviewTransaction {
	return {
		id: r.id,
		sessionId: r.session_id,
		workspaceId: r.workspace_id,
		requestId: r.request_id,
		path: r.path,
		selector: r.selector,
		tag: r.tag,
		snippet: r.snippet,
		text: r.text,
		note: r.note,
		domPreviewOps: r.dom_preview_ops ? (JSON.parse(r.dom_preview_ops) as DomOp[]) : null,
		candidateSourcePatch: r.candidate_patch
			? (JSON.parse(r.candidate_patch) as CandidateSourcePatch)
			: null,
		baseFiles: JSON.parse(r.base_files) as BaseFile[],
		status: r.status as PreviewStatus,
		createdAt: r.created_at,
		resolvedAt: r.resolved_at,
	};
}

export interface CreatePreviewInput {
	sessionId: string;
	workspaceId: string;
	path: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	note?: string | null;
}

/** Create a preview transaction in `requested` state; returns its previewId. */
export function createPreview(input: CreatePreviewInput): PreviewTransaction {
	const db = getDb();
	const id = genId("wp");
	const now = Date.now();
	db.prepare(
		`INSERT INTO web_preview
		 (id, session_id, workspace_id, request_id, path, selector, tag, snippet, text, note,
		  dom_preview_ops, candidate_patch, base_files, status, created_at, resolved_at)
		 VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', 'requested', ?, NULL)`,
	).run(
		id,
		input.sessionId,
		input.workspaceId,
		input.path,
		input.selector,
		input.tag,
		input.snippet,
		input.text,
		input.note ?? null,
		now,
	);
	return getPreview(id)!;
}

/** Link the dispatched live request id to the preview (for correlation). */
export function linkRequest(previewId: string, requestId: string): void {
	getDb()
		.prepare(`UPDATE web_preview SET request_id = ? WHERE id = ?`)
		.run(requestId, previewId);
}

export function getPreview(previewId: string): PreviewTransaction | null {
	const row = getDb()
		.prepare(`SELECT * FROM web_preview WHERE id = ?`)
		.get(previewId) as Row | undefined;
	return row ? toTxn(row) : null;
}

export interface AttachPreviewInput {
	domPreviewOps: DomOp[] | null;
	candidateSourcePatch: CandidateSourcePatch | null;
	baseFiles: BaseFile[];
}

/**
 * Attach the agent's reply (preview ops + candidate patch + base hashes) and move
 * the transaction to `preview-ready`. Only valid from `requested`.
 */
export function attachPreview(
	previewId: string,
	input: AttachPreviewInput,
): PreviewTransaction | null {
	const db = getDb();
	const cur = getPreview(previewId);
	if (!cur || cur.status !== "requested") return null;
	db.prepare(
		`UPDATE web_preview
		 SET dom_preview_ops = ?, candidate_patch = ?, base_files = ?, status = 'preview-ready'
		 WHERE id = ? AND status = 'requested'`,
	).run(
		input.domPreviewOps ? JSON.stringify(input.domPreviewOps) : null,
		input.candidateSourcePatch ? JSON.stringify(input.candidateSourcePatch) : null,
		JSON.stringify(input.baseFiles ?? []),
		previewId,
	);
	return getPreview(previewId);
}

/** Terminal transition to accepted / discarded / invalidated. */
export function resolvePreview(
	previewId: string,
	status: "accepted" | "discarded" | "invalidated",
): void {
	getDb()
		.prepare(`UPDATE web_preview SET status = ?, resolved_at = ? WHERE id = ?`)
		.run(status, Date.now(), previewId);
}

/**
 * Atomically claim a `preview-ready` transaction for resolution, moving it to a
 * transient `resolving` state. Returns true only for the single caller that wins
 * the race; concurrent accept/discard attempts get false and must abort. This
 * closes the check-then-act window between reading status and committing.
 */
export function claimForResolve(previewId: string): boolean {
	const res = getDb()
		.prepare(
			`UPDATE web_preview SET status = 'resolving'
			 WHERE id = ? AND status = 'preview-ready'`,
		)
		.run(previewId);
	return res.changes === 1;
}

/** Release a claimed transaction back to `preview-ready` (on recoverable abort). */
export function releaseClaim(previewId: string): void {
	getDb()
		.prepare(
			`UPDATE web_preview SET status = 'preview-ready'
			 WHERE id = ? AND status = 'resolving'`,
		)
		.run(previewId);
}

/** Most recent preview for a session (for status display). */
export function latestPreview(sessionId: string): PreviewTransaction | null {
	const row = getDb()
		.prepare(
			`SELECT * FROM web_preview WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
		)
		.get(sessionId) as Row | undefined;
	return row ? toTxn(row) : null;
}
