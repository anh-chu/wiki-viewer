/**
 * Metadata + link-graph search indexer.
 *
 * Lifecycle:
 *   - ensureIndexer(wsId, rootDir) -- idempotent; starts background initial scan once
 *   - indexFile / deleteFile       -- incremental updates (called by chokidar listener)
 *   - resolveBacklinks / resolveOutlinks / searchFilenames -- indexed lookups
 *   - purgeWorkspace               -- called on workspace delete
 *
 * Content search moved to ripgrep (src/lib/search/rg-search.ts); this module owns
 * the per-workspace file metadata, the wiki-link graph, filename search, and the
 * indexer lifecycle.
 *
 * Thread safety: better-sqlite3 is synchronous and single-threaded. All DB
 * writes are serialised through JS's single thread. Event-loop blocking is
 * avoided by yielding via setImmediate every INITIAL_YIELD_EVERY files.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { getSearchDb } from "./search-db";
import { isIndexableExt, isMarkdownExt } from "./indexable-exts";
import { isDeniedRelPath, looksLikeBinary, safeAbsPath } from "../proof/raw-fs";
import { isNodeApp, isAppFolder } from "../wiki-helpers";
import { parseFrontmatter } from "../markdown/parse-frontmatter";
import { extractWikiLinks, slugFromPath, normalizeSlug } from "../markdown/wikilink";
import { makeMountPruner, type MountPruner } from "../fs/mounts";
import { subscribe } from "./watcher-pool";
import { stripMarkTags } from "./rg-snippet";

// ── Constants ──────────────────────────────────────────────────────────────────

export const MAX_INDEX_BYTES = 1024 * 1024;    // 1 MiB markdown body cap
const BATCH_SIZE = 50;                          // max files per DB transaction
const BATCH_TIMEOUT_MS = 2000;                  // flush pending queue after this many ms
const INITIAL_YIELD_EVERY = 64;                 // setImmediate yield every N files
export const MAX_FILES_PER_WS = 50_000;         // per-workspace row ceiling
const CONTEXT_MAX_LEN = 160;                    // max chars for links.context

/** Shared skip set — one definition, consumed by the agent search route too. */
export const SKIP_DIRS = new Set([
	".proof", ".git", "node_modules", ".next",
	".cache", ".venv", "venv", "__pycache__",
	"target", "dist", "build", ".turbo",
	".pnpm-store", ".pi", ".wiki-viewer",
]);

// ── Per-workspace state ────────────────────────────────────────────────────────

interface WsState {
	rootDir: string;
	initialScanDone: boolean;
	initialScanPromise: Promise<void> | null;
	pendingPaths: Set<string>;
	pendingTimer: ReturnType<typeof setTimeout> | null;
	unsubscribeWatcher: (() => void) | null;
	rowCount: number;           // in-memory counter seeded from DB on ensure
	capped: boolean;            // true once MAX_FILES_PER_WS reached
	cappedLogged: boolean;      // log the warning once
	aborted: boolean;           // set by purgeWorkspace; checked at yield points
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
			rowCount: 0,
			capped: false,
			cappedLogged: false,
			aborted: false,
		};
		states.set(wsId, s);
	}
	return s;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

function upsertFileRow(
	wsId: string,
	relPath: string,
	size: number,
	mtimeNs: bigint,
	sha: string,
	slug: string | null,
): void {
	const db = getSearchDb();
	db.prepare(`
		INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(ws, path) DO UPDATE SET
			size = excluded.size,
			mtime_ns = excluded.mtime_ns,
			sha = excluded.sha,
			slug = excluded.slug,
			indexed_at = excluded.indexed_at
	`).run(wsId, relPath, size, String(mtimeNs), sha, slug ?? null, new Date().toISOString());
}

function removeFileRow(wsId: string, relPath: string): void {
	const db = getSearchDb();
	db.transaction(() => {
		db.prepare(`DELETE FROM files WHERE ws = ? AND path = ?`).run(wsId, relPath);
		db.prepare(`DELETE FROM links WHERE ws = ? AND src_path = ?`).run(wsId, relPath);
	})();
}

function writeLinks(
	wsId: string,
	relPath: string,
	linkOccurrences: Array<{ slug: string; line: number; lineText: string; index: number }>,
): void {
	if (linkOccurrences.length === 0) return;
	const db = getSearchDb();

	// Dedupe by target_slug; PK-level dedupe plus in-memory Set per file.
	const seen = new Set<string>();
	const rows: Array<{ slug: string; line: number; context: string }> = [];

	for (const occ of linkOccurrences) {
		if (seen.has(occ.slug)) continue;
		seen.add(occ.slug);

		// Build context: strip <mark> from line, wrap the [[…]] in <mark>,
		// truncate to CONTEXT_MAX_LEN around the link.
		const clean = stripMarkTags(occ.lineText);

		// Find the wikilink in the stripped text so that literal <mark> tags
		// preceding the link do not corrupt the offsets.
		const searchFor = `[[${occ.slug}`;
		const cleanLower = clean.toLowerCase();
		let linkIdx = cleanLower.indexOf(searchFor.toLowerCase());
		if (linkIdx < 0) linkIdx = Math.min(occ.index, clean.length);

		// Compute endIdx in clean by scanning for closing brackets.
		let endIdx = linkIdx;
		let depth = 0;
		for (let i = linkIdx; i < clean.length; i++) {
			if (clean[i] === "[" && clean[i + 1] === "[") {
				depth++;
				i++;
			} else if (clean[i] === "]" && clean[i + 1] === "]") {
				depth--;
				if (depth === 0) {
					endIdx = i + 2;
					break;
				}
				i++;
			}
		}
		if (endIdx <= linkIdx) endIdx = linkIdx + occ.slug.length + 4;

		const marked = clean.slice(0, linkIdx) + "<mark>" + clean.slice(linkIdx, endIdx) + "</mark>" + clean.slice(endIdx);

		// Truncate to CONTEXT_MAX_LEN around the <mark>
		const markStart = marked.indexOf("<mark>");
		const markEnd = marked.indexOf("</mark>") + 7;
		let context: string;
		if (markStart < 0) {
			context = clean.slice(0, CONTEXT_MAX_LEN);
		} else {
			const half = Math.floor(CONTEXT_MAX_LEN / 2);
			let ctxStart = Math.max(0, markStart - half);
			let ctxEnd = Math.min(marked.length, markEnd + half);
			// Adjust to keep <mark> whole
			if (ctxEnd - ctxStart > CONTEXT_MAX_LEN) {
				ctxEnd = Math.min(marked.length, ctxStart + CONTEXT_MAX_LEN);
			}
			context = marked.slice(ctxStart, ctxEnd);
			if (ctxStart > 0) context = "…" + context;
			if (ctxEnd < marked.length) context = context + "…";
		}

		rows.push({ slug: occ.slug, line: occ.line, context });
	}

	db.transaction(() => {
		db.prepare(`DELETE FROM links WHERE ws = ? AND src_path = ?`).run(wsId, relPath);
		const insert = db.prepare(
			`INSERT OR IGNORE INTO links (ws, src_path, target_slug, line, context) VALUES (?, ?, ?, ?, ?)`,
		);
		for (const r of rows) {
			insert.run(wsId, relPath, r.slug, r.line, r.context);
		}
	})();
}

// ── File extraction (stat, and only read when markdown) ────────────────────────

interface ExtractedDoc {
	size: number;
	mtimeNs: bigint;
	sha: string;
	slug: string | null;
	links: Array<{ slug: string; line: number; lineText: string; index: number }>;
}

async function extractDoc(
	absPath: string,
	relPath: string,
): Promise<ExtractedDoc | null> {
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(absPath);
	} catch {
		return null;
	}

	const size = st.size;
	const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));

	if (!isMarkdownExt(path.basename(relPath))) {
		// Non-markdown: stat-only. No read, no hash, no links.
		return { size, mtimeNs, sha: "", slug: null, links: [] };
	}

	// Markdown: read up to MAX_INDEX_BYTES.
	if (size > MAX_INDEX_BYTES) {
		// Too large: index metadata only, no links.
		return {
			size,
			mtimeNs,
			sha: "",
			slug: slugFromPath(relPath),
			links: [],
		};
	}

	let buf: Buffer;
	try {
		buf = await readFile(absPath);
	} catch {
		return null;
	}

	const sha = "sha256:" + createHash("sha256").update(buf).digest("hex");

	if (looksLikeBinary(buf)) {
		return { size, mtimeNs, sha, slug: slugFromPath(relPath), links: [] };
	}

	const text = buf.toString("utf-8");
	const parsed = parseFrontmatter(text);
	const links = extractWikiLinks(parsed.body);

	return {
		size,
		mtimeNs,
		sha,
		slug: slugFromPath(relPath),
		links,
	};
}

// ── Index one file ─────────────────────────────────────────────────────────────

async function indexOnePath(wsId: string, rootDir: string, relPath: string): Promise<void> {
	if (isDeniedRelPath(relPath)) return;

	// App-dir contents are opaque leaves; never index files inside an app folder.
	if (await isUnderApp(rootDir, relPath)) {
		removeFileRow(wsId, relPath);
		return;
	}

	// Symlink-escape guard: resolve the realpath and confirm it stays under root.
	const absPath = await safeAbsPath(rootDir, relPath);
	if (!absPath) {
		removeFileRow(wsId, relPath);
		return;
	}

	const db = getSearchDb();

	// Fast-path: check size+mtime against existing meta
	let st: Awaited<ReturnType<typeof stat>>;
	try {
		st = await stat(absPath);
	} catch {
		removeFileRow(wsId, relPath);
		return;
	}

	if (!st.isFile()) return;

	const size = st.size;
	const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));

	const meta = db.prepare(`SELECT size, mtime_ns, sha FROM files WHERE ws = ? AND path = ?`)
		.get(wsId, relPath) as { size: number; mtime_ns: string; sha: string } | undefined;

	if (meta && meta.size === size && BigInt(meta.mtime_ns) === mtimeNs) {
		return; // unchanged
	}

	const extracted = await extractDoc(absPath, relPath);
	if (!extracted) {
		removeFileRow(wsId, relPath);
		return;
	}

	// If we got a sha and it matches the existing meta, just touch indexed_at
	if (meta && extracted.sha && extracted.sha === meta.sha) {
		db.prepare(`UPDATE files SET indexed_at = ? WHERE ws = ? AND path = ?`)
			.run(new Date().toISOString(), wsId, relPath);
		return;
	}

	upsertFileRow(wsId, relPath, extracted.size, extracted.mtimeNs, extracted.sha, extracted.slug);
	writeLinks(wsId, relPath, extracted.links);
}

// ── File tree walker (with mount pruning) ──────────────────────────────────────

async function* walkFiles(
	rootDir: string,
	relDir: string,
	pruner: MountPruner,
): AsyncGenerator<string> {
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
			const childAbs = path.join(rootDir, childRel);
			// Never recurse into pruned mounts.
			if (pruner.isPruned(childAbs)) continue;
			// App dirs (package.json or index.html) are opaque leaves.
			if (await isNodeApp(rootDir, childRel) || await isAppFolder(rootDir, childRel)) {
				continue;
			}
			yield* walkFiles(rootDir, childRel, pruner);
		} else if (item.isFile() || item.isSymbolicLink()) {
			yield childRel;
		}
	}
}

async function isUnderApp(rootDir: string, relPath: string): Promise<boolean> {
	const parts = relPath.split("/");
	for (let i = 1; i < parts.length; i++) {
		const ancestor = parts.slice(0, i).join("/");
		if (await isNodeApp(rootDir, ancestor) || await isAppFolder(rootDir, ancestor)) {
			return true;
		}
	}
	return false;
}

// ── Initial scan ───────────────────────────────────────────────────────────────

async function initialScan(wsId: string, rootDir: string): Promise<void> {
	const db = getSearchDb();
	const s = getState(wsId, rootDir);
	const pruner = makeMountPruner(rootDir);

	// Seed the in-memory row counter.
	const countRow = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws = ?`).get(wsId) as { n: number };
	s.rowCount = countRow.n;
	if (s.rowCount >= MAX_FILES_PER_WS) {
		s.capped = true;
	}

	let batch: Array<() => void> = [];
	let fileCount = 0;

	async function flushBatch() {
		if (s.aborted) { batch = []; return; }
		if (batch.length === 0) return;
		const ops = batch;
		batch = [];
		db.transaction(() => {
			for (const op of ops) op();
		})();
	}

	for await (const relPath of walkFiles(rootDir, "", pruner)) {
		if (s.aborted) break;
		if (isDeniedRelPath(relPath)) continue;

		const absPath = await safeAbsPath(rootDir, relPath);
		if (!absPath) continue;

		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(absPath);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;

		const size = st.size;
		const mtimeNs = BigInt(Math.round(st.mtimeMs * 1_000_000));

		const meta = db.prepare(`SELECT size, mtime_ns FROM files WHERE ws = ? AND path = ?`)
			.get(wsId, relPath) as { size: number; mtime_ns: string } | undefined;

		if (meta && meta.size === size && BigInt(meta.mtime_ns) === mtimeNs) {
			fileCount++;
			if (fileCount % INITIAL_YIELD_EVERY === 0) {
				await new Promise<void>((r) => setImmediate(r));
			}
			continue;
		}

		// Skip new inserts when at cap, but always update rows already in the
		// table (rename case, mtime change, etc.). Decision 23: cap new inserts,
		// never evict existing rows.
		if (s.capped && !meta) {
			continue;
		}

		const extracted = await extractDoc(absPath, relPath);
		if (!extracted) continue;

		const capSize = extracted.size;
		const capMtime = extracted.mtimeNs;
		const capSha = extracted.sha;
		const capSlug = extracted.slug;
		const capLinks = extracted.links;

		batch.push(() => {
			upsertFileRow(wsId, relPath, capSize, capMtime, capSha, capSlug);
			// writeLinks inside the batch would need its own txn; we merge by
			// collecting link ops and running them after file ops.
			// For simplicity in the initial scan, links are written inline.
			const db2 = getSearchDb();
			db2.prepare(`DELETE FROM links WHERE ws = ? AND src_path = ?`).run(wsId, relPath);
			const seen = new Set<string>();
			const insert = db2.prepare(
				`INSERT OR IGNORE INTO links (ws, src_path, target_slug, line, context) VALUES (?, ?, ?, ?, ?)`,
			);
			for (const occ of capLinks) {
				if (seen.has(occ.slug)) continue;
				seen.add(occ.slug);
				const clean = stripMarkTags(occ.lineText);
				const searchFor = `[[${occ.slug}`;
				const cleanLower = clean.toLowerCase();
				let linkIdx = cleanLower.indexOf(searchFor.toLowerCase());
				if (linkIdx < 0) linkIdx = Math.min(occ.index, clean.length);
				let endIdx = linkIdx;
				let depth = 0;
				for (let i = linkIdx; i < clean.length; i++) {
					if (clean[i] === "[" && clean[i + 1] === "[") { depth++; i++; }
					else if (clean[i] === "]" && clean[i + 1] === "]") {
						depth--;
						if (depth === 0) { endIdx = i + 2; break; }
						i++;
					}
				}
				if (endIdx <= linkIdx) endIdx = linkIdx + occ.slug.length + 4;
				const marked = clean.slice(0, linkIdx) + "<mark>" + clean.slice(linkIdx, endIdx) + "</mark>" + clean.slice(endIdx);
				const markStart = marked.indexOf("<mark>");
				let ctx = marked;
				if (markStart >= 0) {
					const half = Math.floor(CONTEXT_MAX_LEN / 2);
					const markEnd = marked.indexOf("</mark>") + 7;
					let ctxStart = Math.max(0, markStart - half);
					let ctxEnd = Math.min(marked.length, markEnd + half);
					if (ctxEnd - ctxStart > CONTEXT_MAX_LEN) {
						ctxEnd = Math.min(marked.length, ctxStart + CONTEXT_MAX_LEN);
					}
					ctx = marked.slice(ctxStart, ctxEnd);
					if (ctxStart > 0) ctx = "…" + ctx;
					if (ctxEnd < marked.length) ctx = ctx + "…";
				} else {
					ctx = clean.slice(0, CONTEXT_MAX_LEN);
				}
				insert.run(wsId, relPath, occ.slug, occ.line, ctx);
			}
		});

		s.rowCount++;
		fileCount++;

		// Check cap after increment.
		if (s.rowCount >= MAX_FILES_PER_WS && !s.capped) {
			s.capped = true;
			if (!s.cappedLogged) {
				s.cappedLogged = true;
				console.warn(`[search] row cap reached for workspace ${wsId} (${MAX_FILES_PER_WS} files), new inserts suspended`);
			}
		}

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
	if (s.pendingTimer) return;
	s.pendingTimer = setTimeout(() => flushQueue(wsId), BATCH_TIMEOUT_MS);
}

function flushQueue(wsId: string): void {
	const s = states.get(wsId);
	if (!s || s.pendingPaths.size === 0) return;
	s.pendingTimer = null;
	const paths = Array.from(s.pendingPaths);
	s.pendingPaths.clear();

	const db = getSearchDb();
	const rootDir = s.rootDir;
	void (async () => {
		let ops: Array<() => void> = [];

		const flushOps = async () => {
			if (s.aborted) { ops = []; return; }
			if (ops.length === 0) return;
			const chunk = ops;
			ops = [];
			db.transaction(() => { for (const op of chunk) op(); })();
			await new Promise<void>((r) => setImmediate(r));
		};

		for (const relPath of paths) {
			if (s.aborted) break;
			if (await isUnderApp(rootDir, relPath)) {
				ops.push(() => removeFileRow(wsId, relPath));
				if (ops.length >= BATCH_SIZE) await flushOps();
				continue;
			}
			const absPath = await safeAbsPath(rootDir, relPath);
			if (!absPath) {
				ops.push(() => removeFileRow(wsId, relPath));
				if (ops.length >= BATCH_SIZE) await flushOps();
				continue;
			}
			const extracted = await extractDoc(absPath, relPath).catch(() => null);
			if (!extracted) {
				ops.push(() => removeFileRow(wsId, relPath));
				if (ops.length >= BATCH_SIZE) await flushOps();
				continue;
			}
			const capSize = extracted.size;
			const capMtime = extracted.mtimeNs;
			const capSha = extracted.sha;
			const capSlug = extracted.slug;
			const capLinks = extracted.links;
			ops.push(() => {
				if (s.capped && !db.prepare(`SELECT 1 FROM files WHERE ws=? AND path=?`).get(wsId, relPath)) {
					return; // new file at cap — skip
				}
				upsertFileRow(wsId, relPath, capSize, capMtime, capSha, capSlug);
				db.prepare(`DELETE FROM links WHERE ws = ? AND src_path = ?`).run(wsId, relPath);
				const seen = new Set<string>();
				const insert = db.prepare(
					`INSERT OR IGNORE INTO links (ws, src_path, target_slug, line, context) VALUES (?, ?, ?, ?, ?)`,
				);
				for (const occ of capLinks) {
					if (seen.has(occ.slug)) continue;
					seen.add(occ.slug);
					const clean = stripMarkTags(occ.lineText);
					const searchFor = `[[${occ.slug}`;
					const cleanLower = clean.toLowerCase();
					let linkIdx = cleanLower.indexOf(searchFor.toLowerCase());
					if (linkIdx < 0) linkIdx = Math.min(occ.index, clean.length);
					let endIdx = linkIdx;
					let depth = 0;
					for (let i = linkIdx; i < clean.length; i++) {
						if (clean[i] === "[" && clean[i + 1] === "[") { depth++; i++; }
						else if (clean[i] === "]" && clean[i + 1] === "]") {
							depth--;
							if (depth === 0) { endIdx = i + 2; break; }
							i++;
						}
					}
					if (endIdx <= linkIdx) endIdx = linkIdx + occ.slug.length + 4;
					const marked = clean.slice(0, linkIdx) + "<mark>" + clean.slice(linkIdx, endIdx) + "</mark>" + clean.slice(endIdx);
					const markStart = marked.indexOf("<mark>");
					let ctx = marked;
					if (markStart >= 0) {
						const half = Math.floor(CONTEXT_MAX_LEN / 2);
						const markEnd = marked.indexOf("</mark>") + 7;
						let ctxStart = Math.max(0, markStart - half);
						let ctxEnd = Math.min(marked.length, markEnd + half);
						if (ctxEnd - ctxStart > CONTEXT_MAX_LEN) {
							ctxEnd = Math.min(marked.length, ctxStart + CONTEXT_MAX_LEN);
						}
						ctx = marked.slice(ctxStart, ctxEnd);
						if (ctxStart > 0) ctx = "…" + ctx;
						if (ctxEnd < marked.length) ctx = ctx + "…";
					} else {
						ctx = clean.slice(0, CONTEXT_MAX_LEN);
					}
					insert.run(wsId, relPath, occ.slug, occ.line, ctx);
				}
				if (!s.capped) {
					// Count only truly new rows (we already checked above)
				}
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

	// Seed the row counter before anything else.
	if (!s.initialScanDone && !s.initialScanPromise) {
		try {
			const db = getSearchDb();
			const row = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws = ?`).get(wsId) as { n: number };
			s.rowCount = row.n;
			if (s.rowCount >= MAX_FILES_PER_WS) {
				s.capped = true;
			}
		} catch { /* DB may not exist yet */ }
	}

	if (s.initialScanDone) return;

	if (!s.initialScanPromise) {
		if (!s.unsubscribeWatcher) {
			s.unsubscribeWatcher = subscribe(wsId, rootDir, (ev, relPath) => {
				// Handle degraded-rescan before any path validation — a rescan
				// has no file path and must reach the indexer.
				if (ev === "rescan") {
					console.warn("[search] watcher degraded rescan triggering re-scan for", wsId);
					s.initialScanDone = false;
					s.initialScanPromise = null;
					setImmediate(() => {
						void ensureIndexer(wsId, rootDir);
					});
					return;
				}

				if (!relPath || isDeniedRelPath(relPath)) return;
				if (ev === "add" || ev === "change") {
					enqueueIndex(wsId, relPath);
				} else if (ev === "unlink") {
					void deleteFile(wsId, relPath);
				}
			});
		}

		s.initialScanPromise = new Promise<void>((resolve) => {
			setImmediate(() => {
				void initialScan(wsId, rootDir).then(() => {
					s.initialScanDone = true;
					resolve();
				}).catch((e) => {
					console.error("[search] initial scan error", e);
					s.initialScanPromise = null;
					resolve();
				});
			});
		});
	}
}

/** Index a single file (called on chokidar change/add events). */
export async function indexFile(wsId: string, rootDir: string, relPath: string): Promise<void> {
	await indexOnePath(wsId, rootDir, relPath);
}

/** Remove a single file from the index. */
export async function deleteFile(wsId: string, relPath: string): Promise<void> {
	const s = states.get(wsId);
	if (s) {
		s.rowCount = Math.max(0, s.rowCount - 1);
		if (s.capped && s.rowCount < MAX_FILES_PER_WS) {
			s.capped = false;
			s.cappedLogged = false;
		}
	}
	removeFileRow(wsId, relPath);
}

/** Remove all indexed data for a workspace (called on workspace delete). */
export async function purgeWorkspace(wsId: string): Promise<void> {
	const db = getSearchDb();
	const s = states.get(wsId);
	if (s) {
		s.aborted = true;
		if (s.pendingTimer) clearTimeout(s.pendingTimer);
		s.unsubscribeWatcher?.();
	}
	db.transaction(() => {
		db.prepare(`DELETE FROM files WHERE ws = ?`).run(wsId);
		db.prepare(`DELETE FROM links WHERE ws = ?`).run(wsId);
	})();
	states.delete(wsId);
}

// ── Query exports (replacing ftsSearch) ────────────────────────────────────────

export interface IndexedMatch {
	path: string;
	score: number;
	snippet: string;
}

export interface Backlink {
	path: string;
	snippet: string;
}

/**
 * Resolve confirmed backlinks to a page via indexed link-graph lookup.
 *
 * Returns every source page that contains [[slug]] in `links`, excluding
 * `excludePath` (the target page itself). Slugs are normalised to lowercase.
 * The `context` column provides the snippet.
 */
export function resolveBacklinks(
	wsId: string,
	slug: string,
	excludePath: string,
	limit: number,
): Backlink[] {
	const norm = normalizeSlug(slug);
	if (!norm) return [];

	const hardLimit = Math.min(Math.max(1, limit), 200);
	const db = getSearchDb();

	let rows: Array<{ src_path: string; context: string }>;
	try {
		rows = db.prepare(`
			SELECT src_path, context
			FROM links
			WHERE ws = ? AND target_slug = ? AND src_path <> ?
			LIMIT ?
		`).all(wsId, norm, excludePath, hardLimit) as typeof rows;
	} catch (e) {
		console.error("[search] resolveBacklinks error", e);
		return [];
	}

	return rows.map((r) => ({ path: r.src_path, snippet: r.context }));
}

export interface OutlinkEntry {
	slug: string;
	resolved_path: string | null;
	exists: boolean;
}

export interface OutlinkResult {
	indexed: boolean;
	links: OutlinkEntry[];
}

/**
 * Resolve outlinks for a file: which slugs it links to, and whether each
 * target exists in the same workspace.
 *
 * `indexed` is false when the source path is not in `files` (the 404 case).
 */
export function resolveOutlinks(wsId: string, relPath: string): OutlinkResult {
	const db = getSearchDb();

	const fileRow = db.prepare(`SELECT 1 FROM files WHERE ws = ? AND path = ?`).get(wsId, relPath);
	if (!fileRow) return { indexed: false, links: [] };

	const slugRows = db.prepare(
		`SELECT target_slug FROM links WHERE ws = ? AND src_path = ? ORDER BY target_slug`,
	).all(wsId, relPath) as Array<{ target_slug: string }>;

	if (slugRows.length === 0) return { indexed: true, links: [] };

	const slugs = slugRows.map((r) => r.target_slug);

	// Batch resolve: one query for all slugs.
	const placeholders = slugs.map(() => "?").join(",");
	const resolved = db.prepare(
		`SELECT path, slug FROM files WHERE ws = ? AND slug IN (${placeholders})`,
	).all(wsId, ...slugs) as Array<{ path: string; slug: string }>;

	const bySlug = new Map<string, string>();
	for (const r of resolved) {
		if (!bySlug.has(r.slug)) bySlug.set(r.slug, r.path);
	}

	const links: OutlinkEntry[] = slugs.map((slug) => {
		const resolved_path = bySlug.get(slug) ?? null;
		return { slug, resolved_path, exists: resolved_path !== null };
	});

	return { indexed: true, links };
}

/**
 * Filename search within a workspace. Multi-token AND: each whitespace-separated
 * token must appear (case-insensitive) in the path. Preserves the old FTS `name`
 * column behaviour, including finding binary files by name.
 */
export function searchFilenames(
	wsId: string,
	query: string,
	limit: number,
): Array<{ path: string }> {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const tokens = trimmed.split(/\s+/).slice(0, 8);
	const hardLimit = Math.min(Math.max(1, limit), 200);
	const db = getSearchDb();

	// Single-token fast path.
	if (tokens.length === 1) {
		const rows = db.prepare(
			`SELECT path FROM files WHERE ws = ? AND LOWER(path) LIKE ? LIMIT ?`,
		).all(wsId, `%${tokens[0]!.toLowerCase()}%`, hardLimit) as Array<{ path: string }>;
		return rows;
	}

	// Multi-token: intersect.
	const clauses = tokens.map(() => `LOWER(path) LIKE ?`).join(" AND ");
	const params = tokens.map((t) => `%${t.toLowerCase()}%`);
	const rows = db.prepare(
		`SELECT path FROM files WHERE ws = ? AND (${clauses}) LIMIT ?`,
	).all(wsId, ...params, hardLimit) as Array<{ path: string }>;
	return rows;
}

/**
 * Number of indexed files for a workspace.
 * Used by tests and the degraded-mode decision in routes.
 */
export function indexedFileCount(wsId: string): number {
	const db = getSearchDb();
	const row = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws = ?`).get(wsId) as { n: number };
	return row.n;
}

// ── Test hooks ─────────────────────────────────────────────────────────────────

export function _resetIndexer(): void {
	for (const s of states.values()) {
		if (s.pendingTimer) clearTimeout(s.pendingTimer);
		s.unsubscribeWatcher?.();
	}
	states.clear();
}

export async function _waitForIdle(wsId: string): Promise<void> {
	const s = states.get(wsId);
	if (!s) return;
	if (s.initialScanDone) return;
	if (s.initialScanPromise) await s.initialScanPromise;
}
