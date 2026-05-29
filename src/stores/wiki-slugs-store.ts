"use client";
import { create } from "zustand";

type Dir = "entities" | "concepts" | "comparisons" | "root";

interface SlugBuckets {
	entities: string[];
	concepts: string[];
	comparisons: string[];
	root: string[];
}

interface WikiSlugsState {
	slugs: Set<string>;
	slugDir: Map<string, Dir>;
	loadedAt: number | null;
	loading: boolean;
	load(): Promise<void>;
	has(slug: string): boolean;
	getDir(slug: string): Dir | null;
	invalidate(): void;
}

export type { Dir as WikiSlugDir };

export const useWikiSlugsStore = create<WikiSlugsState>((set, get) => ({
	slugs: new Set<string>(),
	slugDir: new Map<string, Dir>(),
	loadedAt: null,
	loading: false,

	load: async () => {
		const { loadedAt, loading } = get();
		if (loading) return;
		if (loadedAt !== null && Date.now() - loadedAt < 10_000) return;

		set({ loading: true });
		try {
			const res = await fetch("/api/wiki/slugs");
			if (!res.ok) throw new Error("Failed to fetch wiki slugs");
			const buckets = (await res.json()) as SlugBuckets;

			const slugs = new Set<string>();
			const slugDir = new Map<string, Dir>();

			const dirs: Dir[] = ["entities", "concepts", "comparisons", "root"];
			for (const dir of dirs) {
				for (const slug of buckets[dir]) {
					slugs.add(slug);
					// First bucket wins if a slug appears in multiple (shouldn't happen)
					if (!slugDir.has(slug)) {
						slugDir.set(slug, dir);
					}
				}
			}

			set({ slugs, slugDir, loadedAt: Date.now(), loading: false });
		} catch {
			set({ loading: false });
		}
	},

	has(slug: string): boolean {
		return get().slugs.has(slug);
	},

	getDir(slug: string): Dir | null {
		return get().slugDir.get(slug) ?? null;
	},

	invalidate(): void {
		set({ loadedAt: null });
	},
}));
