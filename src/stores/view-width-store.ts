"use client";
import { create } from "zustand";

export type ViewWidth = "narrow" | "normal" | "wide";
export type ViewAlign = "center" | "left";

const STORAGE_KEY = "wiki-view-width";
const ALIGN_STORAGE_KEY = "wiki-view-align";

/** Tailwind max-width class per setting. "wide" removes the cap. */
export const VIEW_WIDTH_CLASS: Record<ViewWidth, string> = {
	narrow: "max-w-2xl",
	normal: "max-w-5xl",
	wide: "max-w-[90rem]",
};

/** CSS max-width value per setting, for use via the --editor-max-w variable. */
export const VIEW_WIDTH_CSS: Record<ViewWidth, string> = {
	narrow: "42rem",
	normal: "64rem",
	wide: "90rem",
};

export const VIEW_WIDTH_LABEL: Record<ViewWidth, string> = {
	narrow: "Narrow",
	normal: "Normal",
	wide: "Wide",
};

export const VIEW_WIDTH_ORDER: ViewWidth[] = ["narrow", "normal", "wide"];

export const VIEW_ALIGN_LABEL: Record<ViewAlign, string> = {
	center: "Center",
	left: "Left",
};

export const VIEW_ALIGN_ORDER: ViewAlign[] = ["center", "left"];

/** Tailwind horizontal-margin class per alignment, for the content wrapper. */
export const VIEW_ALIGN_CLASS: Record<ViewAlign, string> = {
	center: "mx-auto",
	left: "mr-auto",
};

/** CSS left-margin value per alignment, for use via the --editor-ml variable. */
export const VIEW_ALIGN_ML: Record<ViewAlign, string> = {
	center: "auto",
	left: "0",
};

function loadInitial(): ViewWidth {
	if (typeof window === "undefined") return "normal";
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "narrow" || saved === "normal" || saved === "wide") {
		return saved;
	}
	return "normal";
}

function loadInitialAlign(): ViewAlign {
	if (typeof window === "undefined") return "center";
	const saved = localStorage.getItem(ALIGN_STORAGE_KEY);
	if (saved === "center" || saved === "left") {
		return saved;
	}
	return "center";
}

interface ViewWidthState {
	width: ViewWidth;
	align: ViewAlign;
	setWidth: (width: ViewWidth) => void;
	setAlign: (align: ViewAlign) => void;
	cycle: () => void;
}

export const useViewWidthStore = create<ViewWidthState>((set) => ({
	width: loadInitial(),
	align: loadInitialAlign(),
	setWidth: (width) => {
		if (typeof window !== "undefined") {
			localStorage.setItem(STORAGE_KEY, width);
		}
		set({ width });
	},
	setAlign: (align) => {
		if (typeof window !== "undefined") {
			localStorage.setItem(ALIGN_STORAGE_KEY, align);
		}
		set({ align });
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
