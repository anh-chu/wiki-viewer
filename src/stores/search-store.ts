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

export const useSearchStore = create<SearchState>((set) => ({
	query: "",
	results: [],
	loading: false,
	truncated: false,
	open: false,

	setQuery: (q) => set({ query: q }),
	setOpen: (b) => set({ open: b }),

	clear: () => {
		abortRef?.abort();
		set({ query: "", results: [], loading: false, truncated: false });
	},

	search: async (q) => {
		abortRef?.abort();
		const ctrl = new AbortController();
		abortRef = ctrl;

		if (!q.trim()) {
			set({ results: [], loading: false, truncated: false });
			return;
		}

		set({ loading: true });

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
	},
}));
