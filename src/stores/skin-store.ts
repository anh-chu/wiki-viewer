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
	// Editorial is the default; only an explicit "default" opt-out turns it off.
	if (typeof window === "undefined") return "editorial";
	const attr = document.documentElement.dataset.skin;
	return attr === "editorial" ? "editorial" : "default";
}

interface SkinState {
	skin: Skin;
	setSkin: (skin: Skin) => void;
}

export const useSkinStore = create<SkinState>((set) => ({
	skin: loadInitial(),
	setSkin: (skin) => {
		if (typeof window !== "undefined") {
			if (skin === "default") {
				document.documentElement.removeAttribute("data-skin");
				localStorage.setItem(STORAGE_KEY, "default");
			} else {
				document.documentElement.setAttribute("data-skin", "editorial");
				localStorage.removeItem(STORAGE_KEY);
			}
		}
		set({ skin });
	},
}));
