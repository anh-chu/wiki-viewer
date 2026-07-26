/**
 * Zustand store for backlinks ("Linked from") state.
 *
 * The panel renders one target file at a time, so the reactive slice mirrors
 * search-store: a single { path, backlinks, loading } view. The per-target
 * cache and the inflight map live at module level, mirroring editor-store's
 * pageMemCache / inflightPages.
 */
import { create } from "zustand";
import { wsFetch } from "@/lib/workspace-client";

export interface BacklinkEntry {
	path: string;
	snippet: string;
}

interface CacheEntry {
	data: BacklinkEntry[];
	loadedAt: number;
}

/** Results are re-fetched once a cached entry is older than this. */
const TTL_MS = 60_000;
/** Bounded like pageMemCache so the map can't grow without limit. */
const CACHE_MAX = 30;

// Keyed by TARGET file path (the page whose backlinks these are).
// Insertion-ordered: eviction drops the oldest key.
const cache = new Map<string, CacheEntry>();

// Dedups concurrent fetches for the same target and gives cancel() something
// to abort (mirrors editor-store's inflightPages + search-store's abortRef).
const inflight = new Map<
	string,
	{ promise: Promise<BacklinkEntry[]>; controller: AbortController }
>();

function cacheGet(path: string): BacklinkEntry[] | null {
	const hit = cache.get(path);
	if (!hit) return null;
	if (Date.now() - hit.loadedAt > TTL_MS) {
		cache.delete(path);
		return null;
	}
	return hit.data;
}

function cacheSet(path: string, data: BacklinkEntry[]): void {
	cache.delete(path);
	cache.set(path, { data, loadedAt: Date.now() });
	if (cache.size > CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

interface BacklinksState {
	/** Target path the current `backlinks` belong to. */
	path: string | null;
	backlinks: BacklinkEntry[];
	loading: boolean;
	/**
	 * Bumped by invalidateAll(). Consumers put it in their effect deps so a
	 * watcher event refreshes an open panel instead of showing stale links.
	 */
	cacheVersion: number;

	fetch: (path: string) => Promise<void>;
	cancel: () => void;
	invalidateAll: () => void;
}

export const useBacklinksStore = create<BacklinksState>((set, get) => ({
	path: null,
	backlinks: [],
	loading: false,
	cacheVersion: 0,

	fetch: async (path: string) => {
		if (!path) return;

		const cached = cacheGet(path);
		if (cached) {
			set({ path, backlinks: cached, loading: false });
			return;
		}

		set({ path, backlinks: [], loading: true });

		// Ride an existing request for the same target rather than firing a second.
		const pending = inflight.get(path);
		if (pending) {
			try {
				const data = await pending.promise;
				if (get().path !== path) return;
				set({ backlinks: data, loading: false });
			} catch {
				if (get().path === path) set({ loading: false });
			}
			return;
		}

		const controller = new AbortController();
		const promise = (async (): Promise<BacklinkEntry[]> => {
			const r = await wsFetch(
				`/api/wiki/backlinks?path=${encodeURIComponent(path)}`,
				{ signal: controller.signal },
			);
			if (!r.ok) return [];
			const d = (await r.json()) as { backlinks?: BacklinkEntry[] };
			return d.backlinks ?? [];
		})().finally(() => {
			inflight.delete(path);
		});
		inflight.set(path, { promise, controller });

		try {
			const data = await promise;
			if (controller.signal.aborted) return;
			cacheSet(path, data);
			// A newer fetch() may have superseded us.
			if (get().path !== path) return;
			set({ backlinks: data, loading: false });
		} catch (e) {
			// Superseded/cancelled request — the newer caller owns the state now.
			if ((e as Error).name === "AbortError") return;
			if (get().path !== path) return;
			set({ backlinks: [], loading: false });
		}
	},

	/**
	 * Abort the in-flight request for the current target. Keeps whatever is
	 * already rendered: blanking on cancel would flicker the panel on every
	 * re-run of the caller's effect.
	 */
	cancel: () => {
		const { path } = get();
		if (path) inflight.get(path)?.controller.abort();
		if (get().loading) set({ loading: false });
	},

	/**
	 * Drop every cached target.
	 *
	 * The cache is keyed by TARGET file, but watcher events arrive for SOURCE
	 * files, so precise invalidation would mean parsing each changed file to
	 * learn which targets it links to — I/O on the invalidation path of a cache
	 * whose whole job is avoiding I/O. So any file event clears the whole map:
	 * one extra rg spawn on the next navigation is invisible next to the freeze
	 * this removes.
	 */
	invalidateAll: () => {
		cache.clear();
		set({ cacheVersion: get().cacheVersion + 1 });
	},
}));
