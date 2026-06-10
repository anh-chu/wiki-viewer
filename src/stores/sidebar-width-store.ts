"use client";
import { create } from "zustand";

const STORAGE_KEY = "wiki-sidebar-width";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 600;
export const SIDEBAR_DEFAULT_WIDTH = 288; // matches former w-72 (18rem)

function clamp(w: number): number {
	if (Number.isNaN(w)) return SIDEBAR_DEFAULT_WIDTH;
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(w)));
}

function loadInitial(): number {
	if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) {
		const n = Number.parseInt(saved, 10);
		if (!Number.isNaN(n)) return clamp(n);
	}
	return SIDEBAR_DEFAULT_WIDTH;
}

interface SidebarWidthState {
	width: number;
	setWidth: (width: number) => void;
}

export const useSidebarWidthStore = create<SidebarWidthState>((set) => ({
	width: loadInitial(),
	setWidth: (width) => {
		const w = clamp(width);
		if (typeof window !== "undefined") {
			localStorage.setItem(STORAGE_KEY, String(w));
		}
		set({ width: w });
	},
}));
