/**
 * Zustand store for full-text search state.
 * Shared between the cmd+k palette and the sidebar search box.
 */
import { create } from "zustand";
import { wsFetch } from "@/lib/workspace-client";

export interface SearchMatch {
	path: string;
	score: number;
	snippet: string;
}

interface SearchState {
	query: string;
	results: SearchMatch[];
	loading: boolean;
	truncated: boolean;
	open: boolean;
	setQuery: (q: string) => void;
	setOpen: (b: boolean) => void;
	search: (q: string) => Promise<void>;
	clear: () => void;
}

let abortRef: AbortController | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 150;

export const useSearchStore = create<SearchState>((set) => ({
	query: "",
	results: [],
	loading: false,
	truncated: false,
	open: false,

	setQuery: (q) => set({ query: q }),
	setOpen: (b) => set({ open: b }),

	clear: () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		abortRef?.abort();
		set({ query: "", results: [], loading: false, truncated: false });
	},

	// Debounced: coalesces keystroke bursts into one network round-trip. The
	// trailing fetch still aborts any prior in-flight request via abortRef.
	search: (q) => {
		if (debounceTimer) clearTimeout(debounceTimer);
		if (!q.trim()) {
			abortRef?.abort();
			set({ results: [], loading: false, truncated: false });
			return Promise.resolve();
		}
		set({ loading: true });
		return new Promise<void>((resolve) => {
			debounceTimer = setTimeout(() => {
				void runSearch(set, q).finally(resolve);
			}, DEBOUNCE_MS);
		});
	},
}));

async function runSearch(
	set: (partial: Partial<SearchState>) => void,
	q: string,
): Promise<void> {
	abortRef?.abort();
	const ctrl = new AbortController();
	abortRef = ctrl;

	{
		try {
			const r = await wsFetch("/api/wiki/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ query: q, limit: 30 }),
				signal: ctrl.signal,
			});

			if (!r.ok) {
				set({ results: [], loading: false, truncated: false });
				return;
			}

			const d = (await r.json()) as {
				matches?: SearchMatch[];
				truncated?: boolean;
			};

			if (ctrl.signal.aborted) return;

			set({
				results: d.matches ?? [],
				truncated: !!d.truncated,
				loading: false,
			});
		} catch (e) {
			if ((e as Error).name !== "AbortError") {
				set({ loading: false });
			}
		}
	}
}
