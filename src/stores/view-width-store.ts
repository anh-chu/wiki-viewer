"use client";
import { create } from "zustand";

export type ViewWidth = "narrow" | "normal" | "wide";

const STORAGE_KEY = "wiki-view-width";

/** Tailwind max-width class per setting. "wide" removes the cap. */
export const VIEW_WIDTH_CLASS: Record<ViewWidth, string> = {
	narrow: "max-w-2xl",
	normal: "max-w-4xl",
	wide: "max-w-screen-xl",
};

/** CSS max-width value per setting, for use via the --editor-max-w variable. */
export const VIEW_WIDTH_CSS: Record<ViewWidth, string> = {
	narrow: "42rem",
	normal: "56rem",
	wide: "80rem",
};

export const VIEW_WIDTH_LABEL: Record<ViewWidth, string> = {
	narrow: "Narrow",
	normal: "Normal",
	wide: "Wide",
};

export const VIEW_WIDTH_ORDER: ViewWidth[] = ["narrow", "normal", "wide"];

function loadInitial(): ViewWidth {
	if (typeof window === "undefined") return "normal";
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "narrow" || saved === "normal" || saved === "wide") {
		return saved;
	}
	return "normal";
}

interface ViewWidthState {
	width: ViewWidth;
	setWidth: (width: ViewWidth) => void;
	cycle: () => void;
}

export const useViewWidthStore = create<ViewWidthState>((set) => ({
	width: loadInitial(),
	setWidth: (width) => {
		if (typeof window !== "undefined") {
			localStorage.setItem(STORAGE_KEY, width);
		}
		set({ width });
	},
	cycle: () =>
		set((s) => {
			const idx = VIEW_WIDTH_ORDER.indexOf(s.width);
			const next = VIEW_WIDTH_ORDER[(idx + 1) % VIEW_WIDTH_ORDER.length];
			if (typeof window !== "undefined") {
				localStorage.setItem(STORAGE_KEY, next);
			}
			return { width: next };
		}),
}));
