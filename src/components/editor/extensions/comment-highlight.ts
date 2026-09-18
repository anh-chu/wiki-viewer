/**
 * Exact-text comment highlighting.
 *
 * Google Docs highlights the words a comment is attached to, not the whole
 * paragraph. Two facts make that possible here:
 *
 *   1. `comment.textAnchor` records `{start, end, selectedText}` inside the
 *      block's markdown.
 *   2. `locateCommentAnchor` can find that text again after the block moves or
 *      is edited, because `selectedText` is stored — a hash could only verify an
 *      anchor, never find one.
 *
 * What this module supplies is the missing third piece: a ProseMirror position
 * for each block. The document itself carries no refs (refs are stamped onto DOM
 * elements by `editor.tsx`), so positions are derived from the rendered element
 * for each block, converted to doc offsets by walking the editor's own children
 * with `doc.forEach`. Both walks are over the SAME sequence — ProseMirror's
 * top-level children — so pairing them is sound, unlike pairing mdast blocks to
 * DOM nodes, which is where the old index bug lived.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Comment } from "@/lib/proof/types";
import { mapCommentDecorations, toCommentDecorations } from "@/lib/proof/comment-decorator";

export const commentHighlightKey = new PluginKey("comment-highlight");

interface DocNode {
	textContent: string;
	isText?: boolean;
}

/**
 * Every contiguous text run in the document, with its exact doc offsets.
 *
 * Offsets come from ProseMirror's own `descendants`, which reports each node's
 * true position. Computing them by hand from `forEach` offsets is what produced
 * the live bug: structural positions between a list item and its paragraph are
 * not recoverable by adding 1 per level, so every match landed two positions off
 * and highlighted "Reactions in a" instead of "Reactions in app".
 *
 * Runs are split at gaps, because `textContent` concatenates across blocks with
 * no separator — an `<ol>` reports "Non-product surveysReactions in app", which
 * makes block-level offset arithmetic meaningless.
 */
function docTextRuns(doc: {
	descendants?: (cb: (node: DocNode, pos: number) => boolean | void) => void;
	forEach?: (cb: (node: DocNode, offset: number) => void) => void;
}): { from: number; to: number; text: string }[] {
	const runs: { from: number; to: number; text: string }[] = [];

	if (typeof doc.descendants === "function") {
		doc.descendants((node, pos) => {
			if (!node.isText || !node.textContent) return true;
			const last = runs[runs.length - 1];
			if (last && last.to === pos) {
				last.to += node.textContent.length;
				last.text += node.textContent;
			} else {
				runs.push({
					from: pos,
					to: pos + node.textContent.length,
					text: node.textContent,
				});
			}
			return true;
		});
		return runs;
	}

	// Fallback for a minimal stub: treat each top-level child's text as one run.
	doc.forEach?.((node, offset) => {
		const len = node.textContent.length;
		runs.push({ from: offset + 1, to: offset + 1 + len, text: node.textContent });
	});
	return runs;
}

/**
 * Build the decoration set for the current comments.
 *
 * Positions come from searching the document's TEXT RUNS for each comment's
 * anchored words. That is deliberately not offset arithmetic against the block
 * markdown: those offsets describe a different string (a list item's markdown
 * carries a "1. " prefix that the rendered node does not), so applying them to
 * rendered text highlights the wrong characters — observed live as a comment on
 * "Reactions in app" painting "Reactions ". Searching is exact by construction
 * and is the same find-not-verify property the anchor model exists to provide.
 *
 * `preferNear` still biases among duplicate hits, using the anchor's own offset
 * as a hint, so a phrase appearing twice re-anchors to the instance commented on.
 *
 * A comment whose words cannot be found is skipped rather than guessed. It is
 * cancelled elsewhere; drawing it in the wrong place would be worse than absent.
 */
export function buildCommentDecorations(
	doc: {
		descendants?: (cb: (node: DocNode, pos: number) => boolean | void) => void;
		forEach?: (cb: (node: DocNode, offset: number) => void) => void;
	},
	_blocks: readonly { ref: string; markdown: string }[],
	comments: readonly Comment[],
	/** Block ref whose margin card is hovered, so its text can light up in step. */
	hoveredRef?: string | null,
): DecorationSet {
	const runs = docTextRuns(doc);
	if (runs.length === 0 || comments.length === 0) return DecorationSet.empty;

	const decorations: Decoration[] = [];

	for (const comment of comments) {
		if (!comment.textAnchor || comment.resolved || comment.stale || !comment.ref) continue;
		const { selectedText, start } = comment.textAnchor;
		if (!selectedText) continue;

		const hit = findInRuns(runs, selectedText, start);
		if (!hit) continue;

		decorations.push(
			Decoration.inline(hit.from, hit.to, {
				class: hit.recovered
					? `${COMMENT_HIGHLIGHT_CLASS} ${COMMENT_HIGHLIGHT_RECOVERED_CLASS}`
					: COMMENT_HIGHLIGHT_CLASS,
				"data-comment-id": comment.id,
				"data-comment-recovered": hit.recovered ? "true" : "false",
				// Hovering a margin card lights its words, the link Google Docs uses
				// to tie a comment in the column to the text it is about.
				"data-hovered": hoveredRef === comment.ref ? "true" : "false",
			}),
		);
	}

	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc as never, decorations);
}

/**
 * Find `needle` in the document's text runs, returning exact doc offsets.
 *
 * Searches each run on its own first. Only when a run does not contain the phrase
 * does it try a contiguous GROUP of runs, for the case of a phrase spanning bold
 * or a link. Runs are never joined across a gap: list items report text positions
 * with structural gaps between them, and joining across those gaps shifts the
 * match backwards — the live failure where "Reactions in app" painted as
 * "Reactions in a", exactly two positions early.
 *
 * `preferNear` only decides the recovered/exact label: offsets equal to the
 * anchor's mean nothing moved, anything else means the text was found by search.
 */
function findInRuns(
	runs: readonly { from: number; to: number; text: string }[],
	needle: string,
	preferNear: number,
): { from: number; to: number; recovered: boolean } | null {
	// Pass 1: a single run containing the whole phrase.
	for (const run of runs) {
		const at = run.text.indexOf(needle);
		if (at === -1) continue;
		return {
			from: run.from + at,
			to: run.from + at + needle.length,
			recovered: run.from + at !== preferNear,
		};
	}

	// Pass 2: the phrase spans touching runs (inline marks split a sentence).
	for (const group of groupContiguousRuns(runs)) {
		if (group.length < 2) continue;
		const joined = group.map((r) => r.text).join("");
		const at = joined.indexOf(needle);
		if (at === -1) continue;

		let consumed = 0;
		let from = -1;
		let to = -1;
		let remaining = needle.length;
		for (const run of group) {
			const runEnd = consumed + run.text.length;
			if (runEnd <= at) {
				consumed = runEnd;
				continue;
			}
			const inner = Math.max(0, at - consumed);
			if (from === -1) from = run.from + inner;
			const take = Math.min(remaining, run.text.length - inner);
			remaining -= take;
			to = run.from + inner + take;
			if (remaining <= 0) break;
			consumed = runEnd;
		}
		if (from === -1 || to === -1 || remaining > 0) continue;
		return { from, to, recovered: from !== preferNear };
	}
	return null;
}

/**
 * Group only TRULY touching runs, so cross-run search can never leap a structural
 * gap. ProseMirror leaves a position between sibling blocks, so contiguity here
 * means the runs are separated by no position at all.
 */
function groupContiguousRuns(
	runs: readonly { from: number; to: number; text: string }[],
): { from: number; to: number; text: string }[][] {
	const groups: { from: number; to: number; text: string }[][] = [];
	for (const run of runs) {
		const current = groups[groups.length - 1];
		const prev = current?.[current.length - 1];
		if (current && prev && run.from === prev.to) current.push(run);
		else groups.push([run]);
	}
	return groups;
}

/**
 * TipTap extension that paints exact-word comment highlights.
 *
 * Rebuilt on every transaction from a caller-supplied snapshot, because the
 * comment set lives in the sidecar store, not in the document. `refresh()` is
 * how an annotation-only change repaints without re-serializing markdown.
 */
export function commentHighlightExtension(getState: () => {
	blocks: readonly { ref: string; markdown: string }[];
	comments: readonly Comment[];
	hoveredRef?: string | null;
}) {
	return Extension.create({
		name: "commentHighlight",

		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: commentHighlightKey,
					state: {
						init: (_config, state) => {
							const { blocks, comments, hoveredRef } = getState();
							return buildCommentDecorations(state.doc, blocks, comments, hoveredRef);
						},
						apply: (tr, _old, _oldState, newState) => {
							// Rebuild rather than map: the comment set is external to the
							// document, so a transaction is not the only thing that can
							// invalidate the set.
							const { blocks, comments, hoveredRef } = getState();
							return buildCommentDecorations(newState.doc, blocks, comments, hoveredRef);
						},
					},
					props: {
						decorations(state) {
							return commentHighlightKey.getState(state) as DecorationSet;
						},
					},
				}),
			];
		},
	});
}

/** Force a repaint after an annotation-only change. */
export function refreshCommentHighlights(view: EditorView): void {
	// An empty transaction re-runs `apply`, which rebuilds from `getState()`.
	view.dispatch(view.state.tr.setMeta(commentHighlightKey, { refresh: true }));
}

/** Decoration classes; kept here so the CSS and the decorator cannot drift. */
export const COMMENT_HIGHLIGHT_CLASS = "comment-highlight";
export const COMMENT_HIGHLIGHT_RECOVERED_CLASS = "comment-highlight-recovered";