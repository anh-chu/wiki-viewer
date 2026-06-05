"use client";
import { create } from "zustand";

export interface RecentEntry {
	path: string;
	name: string;
	type?: "file" | "app" | "node-app";
}

interface RecentState {
	recents: RecentEntry[];
	loadForWorkspace: (workspaceId: string | null | undefined) => void;
	push: (entry: RecentEntry, workspaceId: string | null | undefined) => void;
}

const MAX_RECENTS = 15;

function storageKey(ws: string | null | undefined): string {
	return ws ? `wiki-recent-files-${ws}` : "wiki-recent-files";
}

function readStorage(ws: string | null | undefined): RecentEntry[] {
	if (typeof window === "undefined") return [];
	try {
		const raw = localStorage.getItem(storageKey(ws));
		return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
	} catch {
		return [];
	}
}

function writeStorage(ws: string | null | undefined, items: RecentEntry[]): void {
	if (typeof window === "undefined") return;
	localStorage.setItem(storageKey(ws), JSON.stringify(items));
}

export const useRecentStore = create<RecentState>((set) => ({
	recents: [],

	loadForWorkspace: (ws) => {
		set({ recents: readStorage(ws) });
	},

	push: (entry, ws) => {
		const current = readStorage(ws);
		const deduped = current.filter((r) => r.path !== entry.path);
		const next = [entry, ...deduped].slice(0, MAX_RECENTS);
		writeStorage(ws, next);
		set({ recents: next });
	},
}));
