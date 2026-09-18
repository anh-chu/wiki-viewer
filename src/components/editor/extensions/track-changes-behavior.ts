/**
 * The suggesting-mode behaviour layer.
 *
 * `track-changes.ts` defines the marks; this file makes them *happen*: it
 * intercepts typing and deletion when the editor is in suggesting mode, and it
 * applies accept/reject as document transforms.
 *
 * The interception points are ProseMirror plugin hooks rather than TipTap
 * keyboard shortcuts, because a shortcut only sees keys. Typing also arrives via
 * paste, drop, IME composition and input rules, and all of those must be tracked
 * in suggesting mode or the mode leaks untracked edits into the document.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { getEditMode } from "./track-changes";

export const trackChangesKey = new PluginKey("trackChanges");

export interface TrackChangesOptions {
	/** Identity stamped onto every change, e.g. "human" or "ai:agent-7". */
	author?: () => string;
	/** Called after a tracked edit lands, so the sidecar can record it. */
	onTrackedEdit?: (info: {
		markName: string;
		from: number;
		to: number;
		text: string;
	}) => void;
}

/**
 * Mark a range as inserted.
 *
 * Applied by transforming the incoming transaction rather than by appending a
 * second one: appending would put the mark in a separate undo step, so a single
 * Cmd-Z after typing a sentence would remove the mark and the text separately.
 */
export function stampInsertion(
	tr: Transaction,
	from: number,
	to: number,
	mark: Mark,
): Transaction {
	return tr.addMark(from, to, mark);
}

/**
 * Mark a range as deleted, in place of removing it.
 *
 * `range` is the selection; the text stays and gains the deletion mark. Returns
 * null when there is nothing to mark, so the caller can fall through to the
 * default delete — e.g. deleting an image, which has no text to strike.
 */
export function stampDeletion(
	state: EditorState,
	from: number,
	to: number,
	mark: Mark,
): Transaction | null {
	if (from === to) return null;
	const text = state.doc.textBetween(from, to, "\n");
	if (text.length === 0) return null;
	const tr = state.tr.addMark(from, to, mark);
	// Keep the caret after the struck-through text so the user can keep typing.
	tr.setSelection(TextSelection.near(tr.doc.resolve(to)));
	return tr;
}

/** Build a mark of the given type carrying this author's identity. */
function authorMark(
	state: EditorState,
	name: string,
	author: string,
): Mark | null {
	const type = state.schema.marks[name];
	if (!type) return null;
	return type.create({ by: author, at: new Date().toISOString() });
}

interface TrackedRanges {
	insertion: { from: number; to: number }[];
	deletion: { from: number; to: number }[];
	modification: { from: number; to: number }[];
}

/** Walk the doc collecting ranges covered by each tracked mark. */
export function collectTrackedRanges(
	doc: PMNode,
	from = 0,
	to?: number,
): TrackedRanges {
	const end = to ?? doc.content.size;
	const out: TrackedRanges = { insertion: [], deletion: [], modification: [] };

	doc.nodesBetween(from, end, (node, pos) => {
		if (!node.isText) return true;
		for (const mark of node.marks) {
			const bucket = out[mark.type.name as keyof TrackedRanges];
			if (!bucket) continue;
			const start = Math.max(pos, from);
			const stop = Math.min(pos + node.nodeSize, end);
			if (stop <= start) continue;
			// Extend the previous range when this node continues it, so a styled
			// span inside a suggestion yields one range rather than three.
			const last = bucket[bucket.length - 1];
			if (last && last.to === start) last.to = stop;
			else bucket.push({ from: start, to: stop });
		}
		return true;
	});

	return out;
}

/**
 * Apply an accept as a single transaction, so undo restores the whole decision.
 *
 * Order matters: deletions are removed from the END backwards, because each
 * removal shifts every later position. Insertions need no work — the text is
 * already present, and only the mark is dropped.
 */
export function applyAccept(state: EditorState): Transaction | null {
	const ranges = collectTrackedRanges(state.doc);
	if (
		ranges.insertion.length === 0 &&
		ranges.deletion.length === 0 &&
		ranges.modification.length === 0
	) {
		return null;
	}

	let tr = state.tr;
	// Remove deleted text, last range first.
	for (const range of [...ranges.deletion].sort((a, b) => b.from - a.from)) {
		tr = tr.delete(range.from, range.to);
	}
	// Drop every tracked mark; the text that remains is the accepted document.
	for (const name of ["insertion", "deletion", "modification"]) {
		const type = state.schema.marks[name];
		if (type) tr = tr.removeMark(0, tr.doc.content.size, type);
	}
	return tr;
}

/**
 * Apply a reject: insertions are removed, deletions are restored (their text was
 * never gone), and modification marks are dropped.
 */
export function applyReject(state: EditorState): Transaction | null {
	const ranges = collectTrackedRanges(state.doc);
	if (
		ranges.insertion.length === 0 &&
		ranges.deletion.length === 0 &&
		ranges.modification.length === 0
	) {
		return null;
	}

	let tr = state.tr;
	// Remove inserted text, last range first so earlier positions stay valid.
	for (const range of [...ranges.insertion].sort((a, b) => b.from - a.from)) {
		tr = tr.delete(range.from, range.to);
	}
	for (const name of ["insertion", "deletion", "modification"]) {
		const type = state.schema.marks[name];
		if (type) tr = tr.removeMark(0, tr.doc.content.size, type);
	}
	return tr;
}

/**
 * The behaviour extension.
 *
 * `filterTransaction` is the single interception point for typed input. It is
 * deliberately conservative: it only rewrites transactions that are plain text
 * insertions or deletions with no marks of their own, so structural operations
 * (lists, tables, paste of rich content) are left alone rather than corrupted by
 * a partial rewrite.
 */
export function trackChangesExtension(options: TrackChangesOptions = {}) {
	return Extension.create({
		name: "trackChanges",

		addStorage() {
			return { mode: "editing" as const };
		},

		addProseMirrorPlugins() {
			const extension = this;
			return [
				createTrackChangesPlugin({
					getMode: () =>
						getEditMode({ storage: extension.editor.storage }),
					author: () => options.author?.() ?? "human",
					onTrackedEdit: options.onTrackedEdit,
				}),
			];
		},

		addKeyboardShortcuts() {
			return {
				// Docs uses Cmd+Shift+Z for undo-in-suggesting; leaving undo alone and
				// exposing the mode toggle is enough for the POC.
				"Mod-Shift-s": () => {
					const current = getEditMode({ storage: this.editor.storage });
					const next = current === "suggesting" ? "editing" : "suggesting";
					(this.editor.storage as { trackChanges?: { mode: string } }).trackChanges = {
						mode: next,
					};
					this.editor.view.dispatch(
						this.editor.state.tr.setMeta(trackChangesKey, { mode: next }),
					);
					return true;
				},
			};
		},
	});
}

/**
 * True when the transaction is exactly one text DELETION and nothing else.
 *
 * Testing `from`/`to` being numeric is not enough, and getting that wrong was a
 * real bug: an `insertText` step is also a ReplaceStep with numeric from/to (both
 * equal to the caret position), so every insertion was misrouted into the deletion
 * branch and silently vanished. A deletion is a step that CONSUMES document range
 * while adding no text — so the slice being empty is the distinguishing fact.
 */
function isPlainDeletion(tr: Transaction): boolean {
	const step = tr.steps[0] as unknown as {
		from?: number;
		to?: number;
		slice?: { content: { size: number } };
	};
	if (typeof step?.from !== "number" || typeof step?.to !== "number") return false;
	// Nothing to delete when the range is empty.
	if (step.to <= step.from) return false;
	// Text being inserted alongside the removal is a replacement, not a deletion.
	const added = step.slice?.content?.size ?? 0;
	if (added > 0) return false;
	return true;
}

/** The range a deletion transaction removed, in the pre-transaction document. */
function deletionRange(tr: Transaction): { from: number; to: number } {
	const step = tr.steps[0] as unknown as { from: number; to: number };
	// Marks are added to the ORIGINAL positions, which is where the text still is
	// in `state.doc` — the transaction has not been applied yet.
	return { from: step.from, to: step.to };
}

/**
 * Ranges of text this transaction added, in the NEW document's coordinates.
 *
 * Derived by diffing step maps: every position the transaction touched that
 * increases the document is part of an insertion.
 */
function insertedRanges(tr: Transaction): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	tr.mapping.maps.forEach((map) => {
		map.forEach((oldStart, oldEnd, newStart, newEnd) => {
			if (newEnd > newStart && oldEnd === oldStart) {
				ranges.push({ from: newStart, to: newEnd });
			}
		});
	});
	return ranges;
}

/**
 * Build the plugin directly.
 *
 * The extension wraps this so the same instance-under-test is reachable from a
 * test: the coordinate bug this file fixes was invisible to logic-only tests.
 */
export function createTrackChangesPlugin(opts: {
	getMode: () => "editing" | "suggesting";
	author: () => string;
	onTrackedEdit?: (info: {
		markName: string;
		from: number;
		to: number;
		text: string;
	}) => void;
}): Plugin {
	const pendingInsertions: {
		ranges: { from: number; to: number }[];
		mark: Mark;
	}[] = [];
	const pendingDeletions: { from: number; to: number; mark: Mark }[] = [];

	return new Plugin({
		key: trackChangesKey,

		view() {
			return {
				update(view) {
					if (opts.getMode() !== "suggesting") {
						pendingInsertions.length = 0;
						pendingDeletions.length = 0;
						return;
					}
					const insertions = pendingInsertions.splice(0);
					const deletions = pendingDeletions.splice(0);
					if (insertions.length === 0 && deletions.length === 0) return;

					const tr = view.state.tr.setMeta(trackChangesKey, { tracked: true });
					for (const { ranges, mark } of insertions) {
						for (const range of ranges) {
							if (range.to > tr.doc.content.size) continue;
							tr.addMark(range.from, range.to, mark);
							opts.onTrackedEdit?.({
								markName: "insertion",
								from: range.from,
								to: range.to,
								text: tr.doc.textBetween(range.from, range.to, "\n"),
							});
						}
					}
					for (const { from, to, mark } of deletions) {
						if (to > tr.doc.content.size) continue;
						tr.addMark(from, to, mark);
						opts.onTrackedEdit?.({
							markName: "deletion",
							from,
							to,
							text: tr.doc.textBetween(from, to, "\n"),
						});
					}
					view.dispatch(tr);
				},
			};
		},

		filterTransaction(tr, state) {
			if (!tr.docChanged) return true;
			if (opts.getMode() !== "suggesting") return true;
			if (tr.getMeta(trackChangesKey)) return true;

			const author = opts.author();

			if (tr.steps.length === 1 && isPlainDeletion(tr)) {
				const mark = authorMark(state, "deletion", author);
				if (!mark) return true;
				const { from, to } = deletionRange(tr);
				if (from === to) return true;
				pendingDeletions.push({ from, to, mark });
				// Cancel the delete; the view.update pass marks the text instead.
				return false;
			}

			const mark = authorMark(state, "insertion", author);
			if (!mark) return true;
			const inserted = insertedRanges(tr);
			if (inserted.length > 0) pendingInsertions.push({ ranges: inserted, mark });
			return true;
		},
	});
}

/** Accept or reject every tracked change in a range. */
export function acceptTrackedChangesRange(
	state: EditorState,
	decision: "accept" | "reject",
	from = 0,
	to?: number,
): Transaction | null {
	const end = to ?? state.doc.content.size;
	const ranges = collectTrackedRanges(state.doc, from, end);
	if (
		ranges.insertion.length === 0 &&
		ranges.deletion.length === 0 &&
		ranges.modification.length === 0
	) {
		return null;
	}

	// The meta marks this as our own pass. Without it the deletion steps below are
	// re-intercepted as user deletions and re-stamped with a deletion mark, so
	// accept would appear to do nothing.
	let tr = state.tr.setMeta(trackChangesKey, { tracked: true, decision });
	const toRemove = decision === "accept" ? ranges.deletion : ranges.insertion;
	// Last-to-first: removing a range shifts every later position.
	for (const range of [...toRemove].sort((a, b) => b.from - a.from)) {
		tr = tr.delete(range.from, range.to);
	}
	for (const name of ["insertion", "deletion", "modification"]) {
		const type = state.schema.marks[name];
		if (type) tr = tr.removeMark(0, tr.doc.content.size, type);
	}
	return tr;
}

export const __test = { createTrackChangesPlugin };
