/**
 * FTS5 full-text search indexer.
 *
 * Lifecycle:
 *   - ensureIndexer(wsId, rootDir) -- idempotent; starts background initial scan once
 *   - indexFile / deleteFile       -- incremental updates (called by chokidar listener)
 *   - ftsSearch                    -- BM25 search query
 *   - purgeWorkspace               -- called on workspace delete
 *
 * Thread safety: better-sqlite3 is synchronous and single-threaded. All DB
 * writes are serialised through JS's single thread. Event-loop blocking from the
 * initial scan is avoided by yielding via setImmediate every INITIAL_YIELD_EVERY files.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getSearchDb } from "./search-db";
import { sanitizeFtsQuery } from "./sanitize";
import { isIndexableExt, isMarkdownExt } from "./indexable-exts";
import { isDeniedRelPath, looksLikeBinary, safeAbsPath } from "../proof/raw-fs";
import { parseFrontmatter } from "../markdown/parse-frontmatter";
import { subscribe } from "./watcher-pool";

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_INDEX_BYTES = 1024 * 1024;    // 1 MiB body cap
const BATCH_SIZE = 50;                   // max files per DB transaction
const BATCH_TIMEOUT_MS = 2000;           // flush pending queue after this many ms
const INITIAL_YIELD_EVERY = 64;          // setImmediate yield every N files

const SKIP_DIRS = new Set([".proof", ".git", "node_modules", ".next"]);

// ── Per-workspace state ────────────────────────────────────────────────────────

interface WsState {
	rootDir: string;
	initialScanDone: boolean;
	initialScanPromise: Promise<void> | null;
	pendingPaths: Set<string>;
	pendingTimer: ReturnType<typeof setTimeout> | null;
	unsubscribeWatcher: (() => void) | null;
}

const states = new Map<string, WsState>();

function getState(wsId: string, rootDir: string): WsState {
	let s = states.get(wsId);
	if (!s) {
		s = {
			rootDir,
			initialScanDone: false,
			initialScanPromise: null,
			pendingPaths: new Set(),
			pendingTimer: null,
			unsubscribeWatcher: null,
		};
		states.set(wsId, s);
	}
	return s;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

function upsertDoc(
	wsId: string,
	relPath: string,
	name: string,
	frontmatter: string,
	body: string,
	size: number,
	mtimeNs: bigint,
	sha: string,
): void {
	const db = getSearchDb();
	// DELETE + INSERT because FTS5 has no native UPSERT.
	db.prepare(`DELETE FROM docs WHERE ws = ? AND path = ?`).run(wsId, relPath);
	db.prepare(`INSERT INTO docs (ws, path, name, frontmatter, body) VALUES (?, ?, ?, ?, ?)`)
		.run(wsId, relPath, name, frontmatter, body);
	db.prepare(`
		INSERT INTO docs_meta (ws, path, size, mtime_ns, sha, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(ws, path) DO UPDATE SET
			size = excluded.size,
			mtime_ns = excluded.mtime_ns,
			sha = excluded.sha,
			indexed_at = excluded.indexed_at
	`).run(wsId, relPath, size, String(mtimeNs), sha, new Date().toISOString());
}

function removeDoc(wsId: string, relPath: string): void {
	const db = getSearchDb();
	db.prepare(`DELETE FROM docs WHERE ws = ? AND path = ?`).run(wsId, relPath);
	db.prepare(`DELETE FROM docs_meta WHERE ws = ? AND path = ?`).run(wsId, relPath);
}

// ── Text extraction ────────────────────────────────────────────────────────────

async function extractText(
	absPath: string,
	relPath: string,
): Promise<{ name: string; frontmatter: string; body: string; sha: string; size: number; mtimeNs: bigint } | null> {
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(absPath);
	} catch {
		return null;
	}

	const size = st.size;
	const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));
	const name = path.basename(relPath);

	if (size > MAX_INDEX_BYTES) {
		// Too large: index filename only, no body.
		return { name, frontmatter: "", body: "", sha: "", size, mtimeNs };
	}

	let buf: Buffer;
	try {
		buf = await readFile(absPath);
	} catch {
		return null;
	}

	const sha = "sha256:" + createHash("sha256").update(buf).digest("hex");

	if (looksLikeBinary(buf)) {
		return { name, frontmatter: "", body: "", sha, size, mtimeNs };
	}

	const text = buf.toString("utf-8");

	if (isMarkdownExt(name)) {
		const parsed = parseFrontmatter(text);
		const fmStr = Object.entries(parsed.data)
			.map(([k, v]) => `${k} ${Array.isArray(v) ? (v as unknown[]).join(" ") : String(v)}`)
			.join(" ");
		return { name, frontmatter: fmStr, body: parsed.body, sha, size, mtimeNs };
	}

	return { name, frontmatter: "", body: text, sha, size, mtimeNs };
}

// ── Index one file ─────────────────────────────────────────────────────────────

async function indexOnePath(wsId: string, rootDir: string, relPath: string): Promise<void> {
	if (isDeniedRelPath(relPath)) return;

	// Symlink-escape guard: resolve the realpath and confirm it stays under root.
	// A symlink whose target escapes the workspace must never be indexed.
	const absPath = await safeAbsPath(rootDir, relPath);
	if (!absPath) {
		removeDoc(wsId, relPath);
		return;
	}
	const db = getSearchDb();

	// Fast-path: check size+mtime against existing meta
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(absPath);
	} catch {
		// File gone - remove it
		removeDoc(wsId, relPath);
		return;
	}

	if (!st.isFile()) return;

	const size = st.size;
	const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));

	const meta = db.prepare(`SELECT size, mtime_ns, sha FROM docs_meta WHERE ws = ? AND path = ?`)
		.get(wsId, relPath) as { size: number; mtime_ns: string; sha: string } | undefined;

	if (meta && meta.size === size && BigInt(meta.mtime_ns) === mtimeNs) {
		// Unchanged - skip
		return;
	}

	const extracted = await extractText(absPath, relPath);
	if (!extracted) return;

	// If we got a sha and it matches the existing meta, just touch indexed_at
	if (meta && extracted.sha && extracted.sha === meta.sha) {
		db.prepare(`UPDATE docs_meta SET indexed_at = ? WHERE ws = ? AND path = ?`)
			.run(new Date().toISOString(), wsId, relPath);
		return;
	}

	const name = path.basename(relPath);
	if (!isIndexableExt(name) && !isMarkdownExt(name)) {
		// Non-text: index name only so filename searches work
		upsertDoc(wsId, relPath, name, "", "", size, mtimeNs, extracted.sha);
		return;
	}

	upsertDoc(wsId, relPath, extracted.name, extracted.frontmatter, extracted.body, extracted.size, extracted.mtimeNs, extracted.sha);
}

// ── File tree walker ───────────────────────────────────────────────────────────

async function* walkFiles(rootDir: string, relDir: string): AsyncGenerator<string> {
	let items: Dirent[];
	try {
		items = await readdir(path.join(rootDir, relDir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const item of items) {
		if (SKIP_DIRS.has(item.name)) continue;
		const childRel = relDir ? `${relDir}/${item.name}` : item.name;
		if (item.isDirectory()) {
			yield* walkFiles(rootDir, childRel);
		} else if (item.isFile() || item.isSymbolicLink()) {
			yield childRel;
		}
	}
}

// ── Initial scan ───────────────────────────────────────────────────────────────

async function initialScan(wsId: string, rootDir: string): Promise<void> {
	const db = getSearchDb();
	let batch: Array<() => void> = [];
	let fileCount = 0;

	async function flushBatch() {
		if (batch.length === 0) return;
		const ops = batch;
		batch = [];
		db.transaction(() => {
			for (const op of ops) op();
		})();
	}

	for await (const relPath of walkFiles(rootDir, "")) {
		if (isDeniedRelPath(relPath)) continue;

		// Schedule the actual index work
		const relPathCopy = relPath;

		// Symlink-escape guard: skip anything whose realpath leaves the workspace.
		const absPath = await safeAbsPath(rootDir, relPathCopy);
		if (!absPath) continue;

		// Stat + read inline (can't easily capture async in sync txn)
		// We collect the data async, then write in a batch txn
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(absPath);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;

		const size = st.size;
		const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));

		const meta = db.prepare(`SELECT size, mtime_ns FROM docs_meta WHERE ws = ? AND path = ?`)
			.get(wsId, relPathCopy) as { size: number; mtime_ns: string } | undefined;

		if (meta && meta.size === size && BigInt(meta.mtime_ns) === mtimeNs) {
			fileCount++;
			if (fileCount % INITIAL_YIELD_EVERY === 0) {
				await new Promise<void>((r) => setImmediate(r));
			}
			continue;
		}

		const extracted = await extractText(absPath, relPathCopy);
		if (!extracted) continue;

		const name = path.basename(relPathCopy);
		const shouldIndexBody = isIndexableExt(name) || isMarkdownExt(name);
		const fBody = shouldIndexBody ? extracted.body : "";
		const fFm   = shouldIndexBody ? extracted.frontmatter : "";

		const capSize = extracted.size;
		const capMtime = extracted.mtimeNs;
		const capSha = extracted.sha;

		batch.push(() => {
			db.prepare(`DELETE FROM docs WHERE ws = ? AND path = ?`).run(wsId, relPathCopy);
			db.prepare(`INSERT INTO docs (ws, path, name, frontmatter, body) VALUES (?, ?, ?, ?, ?)`)
				.run(wsId, relPathCopy, extracted.name, fFm, fBody);
			db.prepare(`
				INSERT INTO docs_meta (ws, path, size, mtime_ns, sha, indexed_at)
				VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(ws, path) DO UPDATE SET
					size = excluded.size,
					mtime_ns = excluded.mtime_ns,
					sha = excluded.sha,
					indexed_at = excluded.indexed_at
			`).run(wsId, relPathCopy, capSize, String(capMtime), capSha, new Date().toISOString());
		});

		fileCount++;

		if (batch.length >= BATCH_SIZE) {
			await flushBatch();
			await new Promise<void>((r) => setImmediate(r));
		} else if (fileCount % INITIAL_YIELD_EVERY === 0) {
			await new Promise<void>((r) => setImmediate(r));
		}
	}

	await flushBatch();
}

// ── Batch queue (incremental updates from chokidar) ────────────────────────────

function enqueueIndex(wsId: string, relPath: string): void {
	const s = states.get(wsId);
	if (!s) return;
	s.pendingPaths.add(relPath);
	if (s.pendingTimer) return; // already scheduled
	s.pendingTimer = setTimeout(() => flushQueue(wsId), BATCH_TIMEOUT_MS);
}

function flushQueue(wsId: string): void {
	const s = states.get(wsId);
	if (!s || s.pendingPaths.size === 0) return;
	s.pendingTimer = null;
	const paths = Array.from(s.pendingPaths);
	s.pendingPaths.clear();

	// Index each in a background promise; errors are logged not thrown.
	// Work is chunked at BATCH_SIZE with a setImmediate yield between chunks so a
	// large burst of file changes can never block the event loop in one big
	// synchronous transaction.
	const db = getSearchDb();
	const rootDir = s.rootDir;
	void (async () => {
		let ops: Array<() => void> = [];

		const flushOps = async () => {
			if (ops.length === 0) return;
			const chunk = ops;
			ops = [];
			db.transaction(() => { for (const op of chunk) op(); })();
			await new Promise<void>((r) => setImmediate(r));
		};

		for (const relPath of paths) {
			// Symlink-escape guard before any read.
			const absPath = await safeAbsPath(rootDir, relPath);
			if (!absPath) {
				ops.push(() => removeDoc(wsId, relPath));
				if (ops.length >= BATCH_SIZE) await flushOps();
				continue;
			}
			const extracted = await extractText(absPath, relPath).catch(() => null);
			if (!extracted) {
				ops.push(() => removeDoc(wsId, relPath));
				if (ops.length >= BATCH_SIZE) await flushOps();
				continue;
			}
			const name = path.basename(relPath);
			const shouldIndexBody = isIndexableExt(name) || isMarkdownExt(name);
			const capSize = extracted.size;
			const capMtime = extracted.mtimeNs;
			const capSha = extracted.sha;
			const fBody = shouldIndexBody ? extracted.body : "";
			const fFm   = shouldIndexBody ? extracted.frontmatter : "";
			ops.push(() => {
				db.prepare(`DELETE FROM docs WHERE ws = ? AND path = ?`).run(wsId, relPath);
				db.prepare(`INSERT INTO docs (ws, path, name, frontmatter, body) VALUES (?, ?, ?, ?, ?)`)
					.run(wsId, relPath, extracted.name, fFm, fBody);
				db.prepare(`
					INSERT INTO docs_meta (ws, path, size, mtime_ns, sha, indexed_at)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(ws, path) DO UPDATE SET
						size = excluded.size,
						mtime_ns = excluded.mtime_ns,
						sha = excluded.sha,
						indexed_at = excluded.indexed_at
				`).run(wsId, relPath, capSize, String(capMtime), capSha, new Date().toISOString());
			});
			if (ops.length >= BATCH_SIZE) await flushOps();
		}
		await flushOps();
	})().catch((e) => console.error("[search] flushQueue error", e));
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Ensure the indexer is running for this workspace.
 * Idempotent: concurrent calls share one initial-scan promise.
 * Fire-and-forget from request handlers (catch the promise externally).
 */
export async function ensureIndexer(wsId: string, rootDir: string): Promise<void> {
	const s = getState(wsId, rootDir);

	if (s.initialScanDone) return;

	if (!s.initialScanPromise) {
		// Subscribe to chokidar (permanent listener -- watcher stays alive while indexer exists).
		if (!s.unsubscribeWatcher) {
			s.unsubscribeWatcher = subscribe(wsId, rootDir, (ev, relPath) => {
				if (!relPath || isDeniedRelPath(relPath)) return;
				if (ev === "add" || ev === "change") {
					enqueueIndex(wsId, relPath);
				} else if (ev === "unlink") {
					void deleteFile(wsId, relPath);
				}
			});
		}

		// Kick off the scan in the background via setImmediate to not block the
		// calling request. The promise is stored so subsequent ensureIndexer calls
		// await the same scan instead of spawning a second one.
		s.initialScanPromise = new Promise<void>((resolve) => {
			setImmediate(() => {
				void initialScan(wsId, rootDir).then(() => {
					s.initialScanDone = true;
					resolve();
				}).catch((e) => {
					console.error("[search] initial scan error", e);
					s.initialScanPromise = null; // allow retry
					resolve();
				});
			});
		});
	}

	// Do NOT await: callers call fire-and-forget. Search works on whatever is already indexed.
	// (Tests use _waitForIdle to synchronise.)
}

/** Index a single file (called on chokidar change/add events). */
export async function indexFile(wsId: string, rootDir: string, relPath: string): Promise<void> {
	await indexOnePath(wsId, rootDir, relPath);
}

/** Remove a single file from the index. */
export async function deleteFile(wsId: string, relPath: string): Promise<void> {
	removeDoc(wsId, relPath);
}

/** Remove all indexed data for a workspace (called on workspace delete). */
export async function purgeWorkspace(wsId: string): Promise<void> {
	const db = getSearchDb();
	db.transaction(() => {
		db.prepare(`DELETE FROM docs WHERE ws = ?`).run(wsId);
		db.prepare(`DELETE FROM docs_meta WHERE ws = ?`).run(wsId);
	})();
	// Clean up module state
	const s = states.get(wsId);
	if (s) {
		if (s.pendingTimer) clearTimeout(s.pendingTimer);
		s.unsubscribeWatcher?.();
		states.delete(wsId);
	}
}

export interface IndexedMatch {
	path: string;
	score: number;  // negated BM25 rank (higher = better)
	snippet: string;
}

export interface SearchResult {
	matches: IndexedMatch[];
	truncated: boolean;
}

/**
 * Full-text search within a single workspace.
 *
 * CRITICAL: ws isolation is enforced by `WHERE ws = ?` on every query.
 * This is the ONLY place in the codebase that executes SELECT ... FROM docs
 * returning rows to callers. The ws column is always bound as the first param.
 */
export function ftsSearch(wsId: string, query: string, limit: number): SearchResult {
	const sanitized = sanitizeFtsQuery(query);
	if (!sanitized) return { matches: [], truncated: false };

	const hardLimit = Math.min(Math.max(1, limit), 200);
	const db = getSearchDb();

	let rows: Array<{ path: string; score: number; snippet: string }>;
	try {
		rows = db.prepare(`
			SELECT path,
				rank AS score,
				snippet(docs, 4, '<mark>', '</mark>', '\u2026', 12) AS snippet
			FROM docs
			WHERE ws = ? AND docs MATCH ?
			ORDER BY rank
			LIMIT ?
		`).all(wsId, sanitized, hardLimit + 1) as typeof rows;
	} catch (e) {
		console.error("[search] ftsSearch error", e);
		return { matches: [], truncated: false };
	}

	const truncated = rows.length > hardLimit;
	return {
		matches: rows.slice(0, hardLimit).map((r) => ({
			path: r.path,
			score: -r.score,
			snippet: r.snippet ?? "",
		})),
		truncated,
	};
}

// ── Test hooks ─────────────────────────────────────────────────────────────────

/** Reset all module-level state (for tests). */
export function _resetIndexer(): void {
	for (const s of states.values()) {
		if (s.pendingTimer) clearTimeout(s.pendingTimer);
		s.unsubscribeWatcher?.();
	}
	states.clear();
}

/**
 * Wait until the initial scan for wsId has completed (for tests).
 * Resolves immediately if the scan is already done.
 */
export async function _waitForIdle(wsId: string): Promise<void> {
	const s = states.get(wsId);
	if (!s) return;
	if (s.initialScanDone) return;
	if (s.initialScanPromise) await s.initialScanPromise;
}
