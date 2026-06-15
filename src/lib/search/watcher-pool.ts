/**
 * Shared chokidar watcher pool.
 *
 * Ensures exactly ONE FSWatcher per workspace regardless of how many SSE
 * connections or indexer subscriptions are active. When the last subscriber
 * unsubscribes, the watcher is closed.
 *
 * The watch route and the indexer both subscribe through this pool.
 */
import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { mountsDir } from "@/lib/sshfs";

/**
 * sshfs/FUSE mounts do not deliver inotify events. Detect a mounted rootDir and
 * fall back to polling so live watch still fires on remote-side changes.
 */
function isMountPath(rootDir: string): boolean {
	const mounts = path.resolve(mountsDir());
	const resolved = path.resolve(rootDir);
	const rel = path.relative(mounts, resolved);
	return (
		resolved === mounts ||
		(rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel))
	);
}

export type WatchEvent = "add" | "unlink" | "addDir" | "unlinkDir" | "change";
export type WatchListener = (ev: WatchEvent, relPath: string) => void;

interface PoolEntry {
	watcher: FSWatcher;
	listeners: Set<WatchListener>;
	rootDir: string;
}

const pool = new Map<string, PoolEntry>();

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
	let entry = pool.get(wsId);
	if (!entry) {
		const polling = isMountPath(rootDir);
		const watcher = watch(rootDir, {
			ignoreInitial: true,
			ignored: /(node_modules|\.git|\.next|\.proof)/,
			persistent: true,
			// Remote sshfs mounts: poll (no inotify across FUSE).
			usePolling: polling,
			interval: polling ? 1500 : undefined,
			binaryInterval: polling ? 3000 : undefined,
			awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
		});
		entry = { watcher, listeners: new Set(), rootDir };
		pool.set(wsId, entry);

		const emit = (ev: WatchEvent, abs: string) => {
			const e = pool.get(wsId);
			if (!e) return;
			const rel = path.relative(e.rootDir, abs);
			e.listeners.forEach((l) => {
				try { l(ev, rel); } catch { /* listener errors must not crash the pool */ }
			});
		};

		watcher.on("add",       (p: string) => emit("add",       p));
		watcher.on("unlink",    (p: string) => emit("unlink",    p));
		watcher.on("change",    (p: string) => emit("change",    p));
		watcher.on("addDir",    (p: string) => { const rel = path.relative(rootDir, p); if (rel) emit("addDir",    p); });
		watcher.on("unlinkDir", (p: string) => { const rel = path.relative(rootDir, p); if (rel) emit("unlinkDir", p); });
	}
	entry.listeners.add(fn);

	return () => {
		const e = pool.get(wsId);
		if (!e) return;
		e.listeners.delete(fn);
		if (e.listeners.size === 0) {
			e.watcher.close().catch(() => { /* ignore */ });
			pool.delete(wsId);
		}
	};
}

/** Reset entire pool. Used by tests. */
export function _resetWatcherPool(): void {
	for (const e of pool.values()) {
		e.watcher.close().catch(() => { /* ignore */ });
	}
	pool.clear();
}
