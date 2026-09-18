/**
 * Docs-style suggesting mode, built on ProseMirror marks.
 *
 * WHY MARKS, NOT DECORATIONS
 * --------------------------
 * The previous redline was a decoration layer: it drew boxes over text that had
 * already changed. That cannot support "type directly over the document", because
 * the typed text has to BE in the document — it is the thing being suggested —
 * and a decoration cannot hold content the document does not contain.
 *
 * Marks participate in the document, so authored text carries its own
 * suggestion state. That gives three things decorations could not:
 *
 *   1. You type normally. Insertions are real text with an `insertion` mark, so
 *      the caret, selection, undo and IME all behave as usual.
 *   2. Deletion is a mark, not a removal. Deleting in suggesting mode marks the
 *      range instead of dropping it, so the text is still there to reject back.
 *   3. Accept/reject is a document transform, not a sidecar bookkeeping step.
 *
 * BYTE-IDENTITY IS THE CONSTRAINT THAT SHAPES EVERYTHING HERE
 * ----------------------------------------------------------
 * `.md` is the source of truth and must stay byte-identical while suggestions are
 * pending. So the marks must be stripped BEFORE markdown serialization, not after:
 * once `toDOM` has emitted `<ins>`, Turndown will happily turn it into `~text~`
 * and the file has changed. `track-changes-strip` does that stripping, and
 * `handleUpdate` calls it on the single serialization path.
 *
 * The marks therefore never reach disk — they live only in the editor and in the
 * sidecar's suggestion records.
 */

import { Mark, mergeAttributes } from "@tiptap/core";

/** Attributes every tracked mark carries, so accept/reject can find its author. */
export interface TrackedAttrs {
	/** Suggestion id this change belongs to, linking mark to sidecar record. */
	suggestionId?: string;
	/** Who made the change: a user id or `ai:<agent>`. */
	by?: string;
	/** ISO timestamp, for ordering overlapping suggestions. */
	at?: string;
}

const TRACKED_ATTRIBUTE_SPEC = {
	suggestionId: {
		default: null as string | null,
		parseHTML: (el: HTMLElement) => el.getAttribute("data-suggestion-id"),
		renderHTML: (attrs: Record<string, unknown>) =>
			attrs.suggestionId ? { "data-suggestion-id": attrs.suggestionId as string } : {},
	},
	by: {
		default: null as string | null,
		parseHTML: (el: HTMLElement) => el.getAttribute("data-suggestion-by"),
		renderHTML: (attrs: Record<string, unknown>) =>
			attrs.by ? { "data-suggestion-by": attrs.by as string } : {},
	},
	at: {
		default: null as string | null,
		parseHTML: (el: HTMLElement) => el.getAttribute("data-suggestion-at"),
		renderHTML: (attrs: Record<string, unknown>) =>
			attrs.at ? { "data-suggestion-at": attrs.at as string } : {},
	},
} as const;

/**
 * Text typed while suggesting. Renders as green/underlined, the Docs convention.
 *
 * `excludes` is deliberately empty: a suggestion may be typed inside existing
 * bold or italic text, and Docs allows that. Excluding would silently drop the
 * user's formatting.
 */
export const Insertion = Mark.create({
	name: "insertion",
	// Insertions win over deletions when both could apply, so typing over a
	// deletion-marked range produces an insertion rather than nesting.
	priority: 60,

	addAttributes() {
		return TRACKED_ATTRIBUTE_SPEC;
	},

	parseHTML() {
		return [{ tag: "ins[data-tracked]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"ins",
			mergeAttributes(HTMLAttributes, {
				"data-tracked": "insertion",
				class: "track-insertion",
			}),
			0,
		];
	},
});

/**
 * Text removed while suggesting. Renders struck through, and the text remains.
 *
 * Deliberately NOT `excludes: "insertion"` — a suggestion can replace text, which
 * the UI models as a deletion mark adjacent to an insertion mark rather than
 * nesting them, and forbidding the overlap would make replacement impossible.
 */
export const Deletion = Mark.create({
	name: "deletion",
	priority: 50,

	addAttributes() {
		return TRACKED_ATTRIBUTE_SPEC;
	},

	parseHTML() {
		return [{ tag: "del[data-tracked]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"del",
			mergeAttributes(HTMLAttributes, {
				"data-tracked": "deletion",
				class: "track-deletion",
			}),
			0,
		];
	},
});

/**
 * A range whose formatting changed while suggesting.
 *
 * Kept separate from insertion/deletion because accepting a formatting change
 * means "keep the text, adopt the new mark set" — a different transform from
 * accepting an insertion. Without this third mark a bold-on-existing-text
 * suggestion would have nowhere to live and would apply immediately.
 */
export const Modification = Mark.create({
	name: "modification",
	priority: 40,

	addAttributes() {
		return TRACKED_ATTRIBUTE_SPEC;
	},

	parseHTML() {
		return [{ tag: 'span[data-tracked="modification"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"span",
			mergeAttributes(HTMLAttributes, {
				"data-tracked": "modification",
				class: "track-modification",
			}),
			0,
		];
	},
});

export const trackChangesMarks = [Insertion, Deletion, Modification];

/** Names of the tracked marks, in the order accept/reject should consider them. */
export const TRACKED_MARK_NAMES = ["insertion", "deletion", "modification"] as const;

export type TrackedMarkName = (typeof TRACKED_MARK_NAMES)[number];

/**
 * Editor mode. Docs calls these Editing and Suggesting; the vocabulary is fixed
 * by the UX contract, so these strings are user-facing.
 */
export type EditMode = "editing" | "suggesting";

/**
 * Read the mode off editor storage. Kept in storage rather than React state so
 * ProseMirror keymaps and input rules read it synchronously — a React state read
 * inside a transaction handler would see the previous value.
 */
export function getEditMode(editor: { storage: object }): EditMode {
	const s = editor.storage as { trackChanges?: { mode?: EditMode } };
	return s.trackChanges?.mode ?? "editing";
}

export function setEditMode(editor: { storage: object }, mode: EditMode): void {
	const s = editor.storage as { trackChanges?: { mode?: EditMode } };
	s.trackChanges = { ...s.trackChanges, mode };
}