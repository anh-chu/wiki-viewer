"use client";
import { create } from "zustand";

const STORAGE_KEY = "wiki-show-hidden";

function loadInitial(): boolean {
	if (typeof window === "undefined") return false;
	return localStorage.getItem(STORAGE_KEY) === "1";
}

interface ShowHiddenState {
	showHidden: boolean;
	toggle: () => void;
}

export const useShowHiddenStore = create<ShowHiddenState>((set, get) => ({
	showHidden: loadInitial(),
	toggle: () => {
		const next = !get().showHidden;
		if (typeof window !== "undefined") {
			if (next) localStorage.setItem(STORAGE_KEY, "1");
			else localStorage.removeItem(STORAGE_KEY);
		}
		set({ showHidden: next });
	},
}));
