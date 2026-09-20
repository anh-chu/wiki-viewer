"use client";

import { create } from "zustand";

/**
 * The annotations panel: what it contains, and whether it is showing.
 *
 * One panel, three booleans, and the counts that make them mean something:
 *
 *   - `panelOpen` — is the pushed panel on screen at all;
 *   - `tab`       — which of the two it shows, or both.
 *
 * The counts are published BY the editor, which is the only thing that can see
 * the document, and the flags are the reader's choices, written only by the
 * overlay button. Keeping the choice separate from the count is what lets a
 * collapse survive a document with no comments while a document that GAINS
 * one still shows its contents.
 *
 * One `tab` rather than two independent booleans: the three tabs are mutually
 * exclusive, so "all" is a real state rather than the accidental sum of two
 * switches, and no combination can exist that the UI has no way to express.
 */

interface AnnotationPanelState {
	/** How many commented blocks the open document has; published by the editor. */
	commentCount: number;
	/** How many pending suggested changes the open document has; published by the editor. */
	suggestionCount: number;

	panelOpen: boolean;
	/** Which of the two the panel shows. One value, so the tabs are mutually exclusive. */
	tab: AnnotationTab;

	setCounts: (comments: number, suggestions: number) => void;
	togglePanel: () => void;
	closePanel: () => void;
	setTab: (tab: AnnotationTab) => void;
	/** Re-show the panel on its comments tab. Used when jumping to a comment. */
	revealComments: () => void;
}

export type AnnotationTab = "all" | "comments" | "changes";

export const useAnnotationPanelStore = create<AnnotationPanelState>((set) => ({
	commentCount: 0,
	suggestionCount: 0,
	panelOpen: false,
	tab: "all",

	setCounts: (comments, suggestions) =>
		set({ commentCount: comments, suggestionCount: suggestions }),

	togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
	closePanel: () => set({ panelOpen: false }),

	setTab: (tab) => set({ tab }),

	// Idempotent, unlike `togglePanel`: a jump-to-comment that hid the very card it
	// was jumping to would be worse than doing nothing.
	revealComments: () => set({ panelOpen: true, tab: "comments" }),
}));

/**
 * What the panel would show, and whether that is worth showing.
 *
 * Pure and exported because it is the panel's only real logic, and both ways it
 * can fail are review failures rather than cosmetic ones: a count that does not
 * match the list beneath it, or an open panel with nothing in it that a reader
 * has to interpret. One definition drives the button's badges, the sections and
 * the empty state.
 */
export function panelContents(state: {
	commentCount: number;
	suggestionCount: number;
	panelOpen: boolean;
	tab: AnnotationTab;
}): {
	comments: number;
	suggestions: number;
	/** Everything the two toggles would show, whether or not the panel is open. */
	total: number;
	/** The panel is open and the toggles between them show nothing. */
	empty: boolean;
} {
	const comments = state.tab === "changes" ? 0 : state.commentCount;
	const suggestions = state.tab === "comments" ? 0 : state.suggestionCount;
	return {
		comments,
		suggestions,
		total: comments + suggestions,
		empty: state.panelOpen && comments === 0 && suggestions === 0,
	};
}