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
 * A comment is anchored to a BLOCK (`comment.ref`), so the search is scoped to that
 * block before the words are looked for. Searching the whole document instead is a
 * real defect, not a theoretical one: with two paragraphs both containing "target",
 * the first `indexOf` hit always won, so a comment on the second paragraph
 * highlighted the first. Scoping by ref is what makes the anchor mean anything.
 *
 * Positions still come from searching the block's TEXT RUNS rather than from offset
 * arithmetic against the block markdown: those offsets describe a different string
 * (a list item's markdown carries a "1. " prefix the rendered node does not), so
 * applying them to rendered text highlights the wrong characters — observed live as
 * a comment on "Reactions in app" painting "Reactions ".
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
	/**
	 * Per-comment resolution from the same read that produced `_blocks`.
	 *
	 * The server resolves each anchor against the document it is serving, so the range
	 * here and the block list can never disagree about which revision they describe.
	 * It is used as a HINT rather than as arithmetic: `offset` is a markdown offset and
	 * this function decorates rendered text, which differs (a list item's markdown
	 * carries the `1. ` prefix its rendered node does not). Using it to choose which
	 * occurrence to highlight is exact; adding it to a document position is not.
	 */
	views?: Record<string, { ref: string | null; offset: number; length: number; status: string }>,
): DecorationSet {
	const runs = docTextRuns(doc);
	if (runs.length === 0 || comments.length === 0) return DecorationSet.empty;

	// Where each top-level block starts and ends, so a comment's search can be
	// limited to its own block. Position order matches `snapshotBlocks` order: the
	// editor stamps `data-block-ref` onto top-level children index-for-index from
	// that snapshot, so a ref's index in `_blocks` is its index in the document.
	const spans = topLevelSpans(doc);
	const indexOfRef = new Map(_blocks.map((b, i) => [b.ref, i]));

	const decorations: Decoration[] = [];

	for (const comment of comments) {
		if (comment.resolved || comment.stale) continue;
		// The resolved view supersedes the stored ref: it is this document's answer, while
		// `comment.ref` may name a block that no longer exists.
		const view = views?.[comment.id];
		const ref = view?.ref ?? comment.ref;
		if (!ref) continue;

		// A comment carries a text anchor only when its author had a selection. The
		// UI sends none for a plain block comment (`...(textAnchor ? {...} : {})` in
		// comment-thread), so requiring one here meant a comment with a visible card
		// in the margin and an icon beside the paragraph highlighted NOTHING — the
		// reader could not tell which words it was about. Google Docs marks the whole
		// block in that case, which is what the fallback below does.
		const selectedText = comment.textAnchor?.selectedText;
		const blockIndex = indexOfRef.get(ref) ?? -1;

		if (!selectedText) {
			// No selection: mark the commented block itself, rather than nothing.
			const span = spans[blockIndex];
			if (!span) continue;
			const inBlock = runs.filter((r) => r.from >= span.from && r.to <= span.to);
			// An empty block has no text to decorate; inline decorations over a
			// zero-length range paint nothing anyway, so there is nothing to add.
			if (inBlock.length === 0) continue;
			for (const run of inBlock) {
				decorations.push(
					Decoration.inline(run.from, run.to, {
						class: COMMENT_HIGHLIGHT_CLASS,
						"data-comment-id": comment.id,
						"data-block-scoped": "true",
						"data-hovered": hoveredRef === ref ? "true" : "false",
					}),
				);
			}
			continue;
		}

		// Scope to the commented block when it can be identified. Falling back to the
		// whole document preserves the previous behaviour for a block the snapshot no
		// longer lists, rather than dropping the highlight entirely.
		const scope = scopeForRef(runs, blockIndex, spans);

		// An anchor the server could not place is not guessed at here either: drawing it
		// somewhere plausible would be worse than leaving it to the lost card.
		if (view && view.status === "lost") continue;

		const hit = findInRuns(scope, selectedText, view?.offset);
		if (!hit) continue;

		decorations.push(
			Decoration.inline(hit.from, hit.to, {
				class: COMMENT_HIGHLIGHT_CLASS,
				"data-comment-id": comment.id,
				// Hovering a margin card lights its words, the link Google Docs uses
				// to tie a comment in the column to the text it is about.
				"data-hovered": hoveredRef === ref ? "true" : "false",
			}),
		);
	}

	if (decorations.length === 0) return DecorationSet.empty;
	return DecorationSet.create(doc as never, decorations);
}

/**
 * The runs belonging to the block at `index`, or every run when the block cannot be
 * identified.
 *
 * Returning all runs is the deliberate fallback: a missing span must degrade to the
 * old behaviour rather than silently dropping a highlight the user can still see a
 * margin card for.
 */
function scopeForRef(
	runs: readonly { from: number; to: number; text: string }[],
	index: number,
	spans: readonly { from: number; to: number }[],
): readonly { from: number; to: number; text: string }[] {
	if (index < 0) return runs;
	const span = spans[index];
	if (!span) return runs;
	const scoped = runs.filter((r) => r.from >= span.from && r.to <= span.to);
	// An empty scope means the block's runs could not be matched to its span, which
	// is a worse signal than "not found" — fall back rather than drop the comment.
	return scoped.length > 0 ? scoped : runs;
}

/** The document-position span of each top-level child. */
function topLevelSpans(doc: {
	forEach?: (cb: (node: DocNode, offset: number) => void) => void;
}): { from: number; to: number }[] {
	const spans: { from: number; to: number }[] = [];
	doc.forEach?.((node: DocNode, offset: number) => {
		const size = (node as unknown as { nodeSize?: number }).nodeSize ??
			(node.textContent?.length ?? 0) + 2;
		spans.push({ from: offset, to: offset + size });
	});
	return spans;
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
 * `preferNear` used to decide a "recovered" label by comparing the match offset to
 * `textAnchor.start`. That comparison was meaningless — `start` is a block-local
 * markdown offset while the match is a document-global ProseMirror position, so the
 * two numbers describe different coordinate systems and can never legitimately be
 * equal. It is gone, and with it the false distinction between an "exact" and a
 * "recovered" highlight: a match inside the commented block is simply the match.
 */
function findInRuns(
	runs: readonly { from: number; to: number; text: string }[],
	needle: string,
	/**
	 * Where the server says the text is, as a markdown offset.
	 *
	 * Only used to CHOOSE among occurrences, never added to a position: markdown offsets
	 * and rendered positions are different coordinate systems (a list item's markdown
	 * carries a `1. ` prefix its rendered node lacks). When the same words appear twice in
	 * a sentence, the occurrence nearest this hint is the one the annotation is on — which
	 * is the client half of the ambiguity the server already resolved.
	 */
	hint?: number,
): { from: number; to: number } | null {
	// Pass 1: a single run containing the whole phrase. Every occurrence is collected so
	// the hint can pick between them; the first match used to win unconditionally, which
	// put a repeated phrase's highlight on the wrong copy.
	let best: { from: number; to: number } | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const run of runs) {
		let at = run.text.indexOf(needle);
		while (at !== -1) {
			const candidate = { from: run.from + at, to: run.from + at + needle.length };
			if (hint === undefined) return candidate;
			const distance = Math.abs(at - hint);
			if (distance < bestDistance) {
				best = candidate;
				bestDistance = distance;
			}
			at = run.text.indexOf(needle, at + 1);
		}
	}
	if (best) return best;

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
		return { from, to };
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
	/** Server-resolved positions, from the same snapshot read as `blocks`. */
	views?: Record<string, { ref: string | null; offset: number; length: number; status: string }>;
}) {
	return Extension.create({
		name: "commentHighlight",

		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: commentHighlightKey,
					state: {
						init: (_config, state) => {
							const { blocks, comments, hoveredRef, views } = getState();
							return buildCommentDecorations(state.doc, blocks, comments, hoveredRef, views);
						},
						apply: (tr, _old, _oldState, newState) => {
							// Rebuild rather than map: the comment set is external to the
							// document, so a transaction is not the only thing that can
							// invalidate the set.
							const { blocks, comments, hoveredRef, views } = getState();
							return buildCommentDecorations(newState.doc, blocks, comments, hoveredRef, views);
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

/** Decoration class; kept here so the CSS and the decorator cannot drift. */
export const COMMENT_HIGHLIGHT_CLASS = "comment-highlight";