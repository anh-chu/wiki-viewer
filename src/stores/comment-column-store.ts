"use client";

import { create } from "zustand";

/**
 * Visibility of the anchored comment column, shared between the top bar and the editor.
 *
 * The control belongs in the TOP BAR, which is shared chrome that renders in both
 * editing and viewing. The state it drives lives in the editor. Prop-drilling it
 * would mean threading it through `viewer-pane` — which does not own the editor and
 * has no other reason to know about comments — so it lives here instead, the way
 * the other cross-cutting view state does.
 *
 * TWO fields, deliberately:
 *
 *   - `count` is published BY the editor, which is the only thing that can see the
 *     document's comments. The top bar reads it to decide whether to offer the
 *     control at all.
 *   - `collapsed` is the reader's CHOICE, and only the top bar writes it.
 *
 * Keeping the choice separate from the count is what lets the column come back
 * automatically when a document has no comments and then gains one, without the
 * reader's earlier collapse being forgotten while they were looking elsewhere.
 */

interface CommentColumnState {
	/** How many commented blocks the open document has; published by the editor. */
	count: number;
	/** The reader hid the column. */
	collapsed: boolean;
	setCount: (count: number) => void;
	toggle: () => void;
	/** Re-show the column. Used when the reader jumps to a comment from the panel. */
	expand: () => void;
}

export const useCommentColumnStore = create<CommentColumnState>((set) => ({
	count: 0,
	collapsed: false,
	setCount: (count) => set({ count }),
	toggle: () => set((state) => ({ collapsed: !state.collapsed })),
	expand: () => set({ collapsed: false }),
}));