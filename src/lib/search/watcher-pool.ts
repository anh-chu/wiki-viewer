/**
 * Shared chokidar watcher pool.
 *
 * Keyed by filesystem tree (realpath of rootDir), not workspace id. Ancestor
 * merge collapses N workspace ids over one tree into one watcher — including
 * the ephemeral ?root= case — with no special-casing. Per-listener rebasing
 * preserves the invariant that each subscriber receives paths relative to its
 * own root, so ancestor merging never corrupts the SSE route's relPath or the
 * indexer's DB key.
 *
 * Deliberate consequence of followSymlinks:false — files inside an in-root
 * symlinked DIRECTORY are no longer live-watched (they are still picked up by
 * the initial scan and by the degraded rescan). This fixes an existing silent
 * bug where chokidar emitted realpaths, producing relPath values starting with
 * "../../" that the indexer's safeAbsPath rejected, so those files were never
 * indexed at all.
 */
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { realpathSync } from "node:fs";
import {
	makeMountPruner,
	rootIsHazardMount,
	_clearMountCache,
	type MountPruner,
} from "@/lib/fs/mounts";

// ── Types ────────────────────────────────────────────────────────────────────

export type WatchEvent = "add" | "unlink" | "addDir" | "unlinkDir" | "change" | "rescan";
export type WatchListener = (ev: WatchEvent, relPath: string) => void;

interface Listener {
	fn: WatchListener;
	base: string; // that subscriber's own realpath'd root
}

interface PoolEntry {
	watcher: FSWatcher;
	watchRoot: string;
	listeners: Set<Listener>;
	pruner: MountPruner;
	degraded: boolean;
	errorCount: number;
	lastErrorLogMs: number;
	// pending flush state
	pending: Map<string, { ev: WatchEvent; abs: string }>;
	flushTimer: ReturnType<typeof setTimeout> | null;
}

// ── Config ───────────────────────────────────────────────────────────────────

const WATCH_FLUSH_MS = 200;
const MAX_WATCH_ERRORS = 20;
const ERROR_LOG_INTERVAL_MS = 30_000;

/** Name-based skip set — matched as path *segments*, not substrings. */
const SKIP_NAMES = new Set(["node_modules", ".git", ".next", ".proof"]);

// ── Pool ─────────────────────────────────────────────────────────────────────

const pool = new Map</* watchRoot */ string, PoolEntry>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isSkipSegment(segment: string): boolean {
	return SKIP_NAMES.has(segment);
}

/** True when any path segment of absPath is a skip name. */
function hasSkipSegment(absPath: string): boolean {
	const segments = absPath.split("/");
	for (const seg of segments) {
		if (seg && isSkipSegment(seg)) return true;
	}
	return false;
}

function resolveWatchRoot(rootDir: string): string {
	try {
		return realpathSync(rootDir);
	} catch {
		return path.resolve(rootDir);
	}
}

/** Is ancestor an ancestor of descendant? Equal counts. */
function isAncestor(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return true;
	const prefix = ancestor.endsWith("/") ? ancestor : ancestor + "/";
	return descendant.startsWith(prefix);
}

/** Is ancestor a STRICT ancestor of descendant? (not equal). */
function isStrictAncestor(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return false;
	const prefix = ancestor.endsWith("/") ? ancestor : ancestor + "/";
	return descendant.startsWith(prefix);
}

/**
 * Remove a listener from whichever pool entry currently holds it, then
 * close the entry if it has no remaining listeners. Safe to call after
 * promotion (the listener may have been copied to a new entry).
 */
function detachListener(listener: Listener): void {
	for (const [wr, e] of pool) {
		if (e.listeners.has(listener)) {
			e.listeners.delete(listener);
			if (e.listeners.size === 0) {
				closeEntry(wr, e);
				pool.delete(wr);
			}
			return;
		}
	}
}

// ── Subscribe / unsubscribe ─────────────────────────────────────────────────

/**
 * Subscribe to file-system events for a workspace.
 * Returns an unsubscribe function. Call it when the subscriber is done.
 * The pool creates a watcher on first subscribe and closes it on last unsubscribe.
 */
export function subscribe(
	wsId: string,
	rootDir: string,
	fn: WatchListener,
): () => void {
	const base = resolveWatchRoot(rootDir);
	const watchRoot = base;
	const listener: Listener = { fn, base };

	// Check for ancestor merge: linear scan over existing entries.
	// VS Code uses a TernarySearchTree at parcelWatcher.ts:692-743 for a scale
	// we do not have — single-digit entries make a linear scan the right cost.
	for (const [existingRoot, entry] of pool) {
		if (isAncestor(existingRoot, watchRoot)) {
			// Existing watcher already covers this tree.
			entry.listeners.add(listener);
			return () => detachListener(listener);
		}
		if (isStrictAncestor(watchRoot, existingRoot)) {
			// New root is an ancestor of existing watchers — promote.
			// Collect all entries that are descendants of watchRoot.
			const promoted: Array<[string, PoolEntry]> = [];
			for (const [er, e] of pool) {
				if (isStrictAncestor(watchRoot, er)) {
					promoted.push([er, e]);
				}
			}
			// Create one watcher at the new root and move all listeners.
			const newEntry = createEntry(watchRoot);
			newEntry.listeners.add(listener);
			for (const [, oldEntry] of promoted) {
				for (const l of oldEntry.listeners) {
					newEntry.listeners.add(l);
				}
				// Transfer pending events before closing the old watcher.
				for (const [key, item] of oldEntry.pending) {
					newEntry.pending.set(key, item);
				}
				if (oldEntry.flushTimer) {
					clearTimeout(oldEntry.flushTimer);
					oldEntry.flushTimer = null;
					// Schedule a flush on the new entry if there were pending events.
					if (!newEntry.flushTimer && newEntry.pending.size > 0) {
						newEntry.flushTimer = setTimeout(() => {
							newEntry.flushTimer = null;
							flushEntry(newEntry);
						}, WATCH_FLUSH_MS);
					}
				}
			}
			pool.set(watchRoot, newEntry);
			// Close old watchers and remove from pool.
			for (const [er, oldEntry] of promoted) {
				// Clear pending/timer first (already transferred above, but
				// closeEntry is defensive about this).
				oldEntry.pending.clear();
				if (oldEntry.flushTimer) {
					clearTimeout(oldEntry.flushTimer);
					oldEntry.flushTimer = null;
				}
				closeEntry(er, oldEntry);
				pool.delete(er);
			}
			return () => detachListener(listener);
		}
	}

	// No ancestor relationship — create a new entry.
	const entry = createEntry(watchRoot);
	entry.listeners.add(listener);
	pool.set(watchRoot, entry);

	return () => detachListener(listener);
}

// ── Entry lifecycle ──────────────────────────────────────────────────────────

function createEntry(watchRoot: string): PoolEntry {
	const polling = rootIsHazardMount(watchRoot);
	const pruner = makeMountPruner(watchRoot);

	const watcher = watch(watchRoot, {
		ignoreInitial: true,
		ignored: (absPath: string) => {
			// Skip name-based patterns matched as path segments.
			if (hasSkipSegment(absPath)) return true;
			// Skip nested hazard mounts.
			return pruner.isPruned(absPath);
		},
		persistent: true,
		followSymlinks: false,
		ignorePermissionErrors: true,
		usePolling: polling,
		interval: polling ? 1500 : undefined,
		binaryInterval: polling ? 3000 : undefined,
		awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
	});

	const entry: PoolEntry = {
		watcher,
		watchRoot,
		listeners: new Set(),
		pruner,
		degraded: false,
		errorCount: 0,
		lastErrorLogMs: 0,
		pending: new Map(),
		flushTimer: null,
	};

	// Shared flush function bound to this entry.
	const scheduleFlush = () => {
		if (entry.flushTimer) return;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			flushEntry(entry);
		}, WATCH_FLUSH_MS);
	};

	const enqueue = (ev: WatchEvent, abs: string) => {
		entry.pending.set(`${ev}\0${abs}`, { ev, abs });
		scheduleFlush();
	};

	watcher.on("add",       (p: string) => enqueue("add",       p));
	watcher.on("unlink",    (p: string) => enqueue("unlink",    p));
	watcher.on("change",    (p: string) => enqueue("change",    p));
	watcher.on("addDir",    (p: string) => enqueue("addDir",    p));
	watcher.on("unlinkDir", (p: string) => enqueue("unlinkDir", p));

	watcher.on("error", (err: unknown) => {
		entry.errorCount++;
		const now = Date.now();
		if (now - entry.lastErrorLogMs > ERROR_LOG_INTERVAL_MS) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`[watcher-pool] watch error #${entry.errorCount} on ${watchRoot}:`,
				msg,
			);
			entry.lastErrorLogMs = now;
		}
		if (entry.errorCount >= MAX_WATCH_ERRORS && !entry.degraded) {
			console.error(
				`[watcher-pool] too many errors on ${watchRoot}, marking degraded`,
			);
			entry.degraded = true;
			entry.watcher.close().catch(() => { /* ignore */ });
			// Emit synthetic rescan to all listeners (Syncthing downgrade pattern).
			sendToAll(entry, "rescan", "");
		}
	});

	return entry;
}

function closeEntry(watchRoot: string, entry: PoolEntry): void {
	if (entry.flushTimer) {
		clearTimeout(entry.flushTimer);
		entry.flushTimer = null;
	}
	entry.pending.clear();
	entry.watcher.close().catch(() => { /* ignore */ });
}

function flushEntry(entry: PoolEntry): void {
	if (entry.degraded) {
		entry.pending.clear();
		return;
	}
	const snapshot = new Map(entry.pending);
	entry.pending.clear();
	for (const [, item] of snapshot) {
		sendToAll(entry, item.ev, item.abs);
	}
}

function sendToAll(entry: PoolEntry, ev: WatchEvent, abs: string): void {
	// Special-case rescan: deliver to all listeners with empty path, bypassing
	// the per-listener rebasing logic (a rescan has no file path).
	if (ev === "rescan") {
		for (const listener of entry.listeners) {
			try { listener.fn(ev, ""); } catch { /* ignore */ }
		}
		return;
	}

	for (const listener of entry.listeners) {
		// Per-listener rebasing: compute relative path from this listener's base.
		// Skip when rel is empty (event on root itself, which chokidar emits for
		// addDir/unlinkDir on the watched root) or escapes above the base (..).
		const rel =
			abs ? path.relative(listener.base, abs) : "";
		if (!rel || rel.startsWith("..")) continue;
		try {
			listener.fn(ev, rel);
		} catch {
			/* listener errors must not crash the pool */
		}
	}
}

// ── Test hooks ───────────────────────────────────────────────────────────────

/** Reset entire pool. Used by tests. */
export function _resetWatcherPool(): void {
	for (const [watchRoot, entry] of pool) {
		closeEntry(watchRoot, entry);
	}
	pool.clear();
	_clearMountCache();
}

/** Number of live watchers (test hook). */
export function _poolSize(): number {
	return pool.size;
}

/**
 * Emit a synthetic error on the FSWatcher for the given watch root.
 * Used by tests to trip the error budget without depending on filesystem
 * permissions.
 */
export function _emitPoolError(watchRoot: string): void {
	const root = resolveWatchRoot(watchRoot);
	const entry = pool.get(root);
	if (!entry) return;
	entry.watcher.emit("error", new Error("synthetic test error"));
}

/**
 * Inject a pending event into a pool entry's throttle buffer.
 * Used by tests to seed pending state before ancestor promotion.
 * The event is delivered after the normal flush delay.
 */
export function _injectPendingEvent(
	watchRoot: string,
	ev: WatchEvent,
	abs: string,
): void {
	const root = resolveWatchRoot(watchRoot);
	const entry = pool.get(root);
	if (!entry) return;
	entry.pending.set(`${ev}\0${abs}`, { ev, abs });
	if (!entry.flushTimer) {
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			flushEntry(entry);
		}, WATCH_FLUSH_MS);
	}
}
