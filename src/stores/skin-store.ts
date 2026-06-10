"use client";
import { create } from "zustand";

export type Skin = "default" | "editorial";

const STORAGE_KEY = "wiki-skin";

export const SKIN_LABEL: Record<Skin, string> = {
	default: "Default",
	editorial: "Editorial",
};

export const SKIN_ORDER: Skin[] = ["default", "editorial"];

function loadInitial(): Skin {
	// Read from the attribute already set by the no-flash script (avoids hydration mismatch).
	if (typeof window === "undefined") return "default";
	const attr = document.documentElement.dataset.skin;
	if (attr === "editorial") return "editorial";
	return "default";
}

interface SkinState {
	skin: Skin;
	setSkin: (skin: Skin) => void;
}

export const useSkinStore = create<SkinState>((set) => ({
	skin: loadInitial(),
	setSkin: (skin) => {
		if (typeof window !== "undefined") {
			if (skin === "editorial") {
				document.documentElement.setAttribute("data-skin", "editorial");
				localStorage.setItem(STORAGE_KEY, "editorial");
			} else {
				document.documentElement.removeAttribute("data-skin");
				localStorage.removeItem(STORAGE_KEY);
			}
		}
		set({ skin });
	},
}));
