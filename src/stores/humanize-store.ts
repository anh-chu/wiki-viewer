"use client";
import { create } from "zustand";

const STORAGE_KEY = "wiki-humanize-names";

function loadInitial(): boolean {
	if (typeof window === "undefined") return false;
	return localStorage.getItem(STORAGE_KEY) === "1";
}

interface HumanizeState {
	humanize: boolean;
	toggle: () => void;
}

export const useHumanizeStore = create<HumanizeState>((set, get) => ({
	humanize: loadInitial(),
	toggle: () => {
		const next = !get().humanize;
		if (typeof window !== "undefined") {
			if (next) localStorage.setItem(STORAGE_KEY, "1");
			else localStorage.removeItem(STORAGE_KEY);
		}
		set({ humanize: next });
	},
}));
