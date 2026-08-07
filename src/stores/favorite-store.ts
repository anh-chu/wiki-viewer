"use client";
import { create } from "zustand";

export interface FavoriteEntry {
	path: string;
	name: string;
	type?: "file" | "dir" | "app" | "node-app";
}

interface FavoriteState {
	favorites: FavoriteEntry[];
	loadForWorkspace: (workspaceId: string | null | undefined) => void;
	toggle: (entry: FavoriteEntry, workspaceId: string | null | undefined) => void;
	isFavorited: (path: string) => boolean;
}

function storageKey(ws: string | null | undefined): string {
	return ws ? `wiki-pinned-files-${ws}` : "wiki-pinned-files";
}

function readStorage(ws: string | null | undefined): FavoriteEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(ws));
		return raw ? (JSON.parse(raw) as FavoriteEntry[]) : [];
	} catch {
		return [];
	}
}

function writeStorage(ws: string | null | undefined, items: FavoriteEntry[]): void {
	if (typeof window === "undefined") return;
	localStorage.setItem(storageKey(ws), JSON.stringify(items));
}

export const useFavoriteStore = create<FavoriteState>((set, get) => ({
	favorites: [],

	loadForWorkspace: (ws) => {
		set({ favorites: readStorage(ws) });
	},

	toggle: (entry, ws) => {
		const current = readStorage(ws);
		const exists = current.some((p) => p.path === entry.path);
		const next = exists
			? current.filter((p) => p.path !== entry.path)
			: [...current, entry];
		writeStorage(ws, next);
		set({ favorites: next });
	},

	isFavorited: (path) => {
		return get().favorites.some((p) => p.path === path);
	},
}));
