"use client";
import { create } from "zustand";

export interface PinnedEntry {
	path: string;
	name: string;
}

interface PinState {
	pins: PinnedEntry[];
	loadForWorkspace: (workspaceId: string | null | undefined) => void;
	toggle: (entry: PinnedEntry, workspaceId: string | null | undefined) => void;
	isPinned: (path: string) => boolean;
}

function storageKey(ws: string | null | undefined): string {
	return ws ? `wiki-pinned-files-${ws}` : "wiki-pinned-files";
}

function readStorage(ws: string | null | undefined): PinnedEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(ws));
		return raw ? (JSON.parse(raw) as PinnedEntry[]) : [];
	} catch {
		return [];
	}
}

function writeStorage(ws: string | null | undefined, items: PinnedEntry[]): void {
	if (typeof window === "undefined") return;
	localStorage.setItem(storageKey(ws), JSON.stringify(items));
}

export const usePinStore = create<PinState>((set, get) => ({
	pins: [],

	loadForWorkspace: (ws) => {
		set({ pins: readStorage(ws) });
	},

	toggle: (entry, ws) => {
		const current = readStorage(ws);
		const exists = current.some((p) => p.path === entry.path);
		const next = exists
			? current.filter((p) => p.path !== entry.path)
			: [...current, entry];
		writeStorage(ws, next);
		set({ pins: next });
	},

	isPinned: (path) => {
		return get().pins.some((p) => p.path === path);
	},
}));
