/**
 * Comment range decorations — highlighting the EXACT commented text (DoD #1).
 *
 * WHY THIS EXISTS
 * ---------------
 * Comments were block-granular: a pip pointed at a whole paragraph and there was
 * no highlight of the words the user actually selected. Worse,
 * `docs/ux-contracts.md` §5.1 *claimed* an exact-text hover highlight, so the
 * contract described behaviour the data model could not produce.
 *
 * Phase 2 added `Comment.textAnchor` (offsets + `selectedText`). This module
 * turns that into ProseMirror decorations.
 *
 * WHY DECORATIONS (the Phase 2 pivot, see anchor-representation-decision.test.ts)
 * ------------------------------------------------------------------------------
 * A comment does not modify the document, so modelling it as a mark would force
 * every save path to strip it forever — a permanent invariant defended for zero
 * benefit. A decoration cannot leak into markdown by construction. Suggestions
 * go the other way (marks, because they must be editable in place) and are made
 * safe by the doc-level strip proven in Phase 3.3.
 *
 * The locate/verify logic is pure and DOM-free so it is testable in the node
 * runner; only `toCommentDecoration` touches ProseMirror.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration } from "@tiptap/pm/view";
import type { Comment, TextRangeAnchor } from "./types";

export interface CommentDecorationDescriptor {
	commentId: string;
	/** PM positions absolute within the document. */
	from: number;
	to: number;
	/** True when the anchor's stored offsets matched; false when re-found by text. */
	recovered: boolean;
	/** Resolved text, for the popover/hover label. */
	text: string;
}

export type CommentAnchorOutcome =
	| { status: "exact"; from: number; to: number }
	| { status: "recovered"; from: number; to: number }
	| { status: "orphaned"; reason: "text-not-found" | "no-block" | "no-anchor" };

/**
 * Locate a comment's text inside a block's plain text.
 *
 * Two-step, and the order matters:
 *   1. TRUST THE OFFSETS when they still reproduce `selectedText`. This is the
 *      common case (nothing moved) and is exact and cheap.
 *   2. FALL BACK TO SEARCH when they do not. This is the step the old model
 *      could not perform at all, because it stored only a hash — which is why
 *      staleness was unrecoverable.
 *
 * `preferNear` biases the search toward where the text used to be, so a phrase
 * that appears twice re-anchors to the instance the user commented on.
 */
export function locateCommentAnchor(
	anchor: TextRangeAnchor | undefined,
	blockText: string,
	preferNear?: number,
): CommentAnchorOutcome {
	if (!anchor || !anchor.selectedText) return { status: "orphaned", reason: "no-anchor" };
	if (!blockText) return { status: "orphaned", reason: "no-block" };

	// 1. Offsets still valid?
	if (
		anchor.start >= 0 &&
		anchor.end <= blockText.length &&
		blockText.slice(anchor.start, anchor.end) === anchor.selectedText
	) {
		return { status: "exact", from: anchor.start, to: anchor.end };
	}

	// 2. Search for the text.
	const needle = anchor.selectedText;
	const hits: number[] = [];
	let at = blockText.indexOf(needle);
	while (at !== -1) {
		hits.push(at);
		at = blockText.indexOf(needle, at + 1);
	}
	if (hits.length === 0) return { status: "orphaned", reason: "text-not-found" };

	const target = preferNear ?? anchor.start;
	let best = hits[0];
	let bestDistance = Math.abs(best - target);
	for (const hit of hits) {
		const distance = Math.abs(hit - target);
		if (distance < bestDistance) {
			best = hit;
			bestDistance = distance;
		}
	}
	return { status: "recovered", from: best, to: best + needle.length };
}

/**
 * Compute PM positions for every comment carrying a text anchor.
 *
 * `blockPositions` maps a block ref to its range in the document, plus the plain
 * text of that block. Callers build it from identity (the stamped ref), never
 * from array index — that was the editor.tsx:493 bug.
 */
export function mapCommentDecorations(
	comments: readonly Comment[],
	blockPositions: ReadonlyMap<
		string,
		{ from: number; to: number; text: string }
	>,
): CommentDecorationDescriptor[] {
	const descriptors: CommentDecorationDescriptor[] = [];

	for (const comment of comments) {
		if (!comment.textAnchor || comment.resolved || comment.stale) continue;
		if (!comment.ref) continue;
		const block = blockPositions.get(comment.ref);
		if (!block) continue;

		// The offsets in the anchor were taken against the BLOCK MARKDOWN, but
		// `block.text` here is the rendered node's plain text. They agree for a
		// simple paragraph and diverge for anything with syntax — a list item's
		// "1. " prefix, emphasis markers, links. Trusting the offsets in that case
		// silently highlights the wrong characters (observed live: a comment on
		// "Reactions in app" painted "Reactions "). So: trust offsets only when the
		// anchor's own baseMarkdown matches the text we are searching, and
		// otherwise search, which is exact by construction.
		const offsetsValid =
			comment.textAnchor.baseMarkdown === undefined ||
			comment.textAnchor.baseMarkdown === block.text ||
			block.text.slice(comment.textAnchor.start, comment.textAnchor.end) ===
				comment.textAnchor.selectedText;

		const outcome = offsetsValid
			? locateCommentAnchor(comment.textAnchor, block.text)
			: locateCommentAnchor(
					{ ...comment.textAnchor, start: -1, end: -1 },
					block.text,
				);
		if (outcome.status === "orphaned") continue;

		// Block content starts one position inside the block node.
		const contentStart = block.from + 1;
		descriptors.push({
			commentId: comment.id,
			from: contentStart + outcome.from,
			to: contentStart + outcome.to,
			recovered: outcome.status === "recovered",
			text: comment.textAnchor.selectedText,
		});
	}

	return descriptors;
}

/** Turn descriptors into ProseMirror decorations. */
export function toCommentDecorations(
	descriptors: readonly CommentDecorationDescriptor[],
): Decoration[] {
	return descriptors.map((d) =>
		Decoration.inline(d.from, d.to, {
			class: d.recovered
				? "comment-highlight comment-highlight-recovered"
				: "comment-highlight",
			"data-comment-id": d.commentId,
			"data-comment-recovered": d.recovered ? "true" : "false",
		}),
	);
}

/** Convenience: walk a ProseMirror doc into identity-keyed block positions. */
export function blockPositionsFromDoc(
	doc: PMNode,
	blocks: readonly { ref: string; markdown: string }[],
): Map<string, { from: number; to: number; text: string }> {
	const positions = new Map<string, { from: number; to: number; text: string }>();
	let index = 0;
	doc.forEach((node, offset) => {
		const block = blocks[index];
		if (block) {
			positions.set(block.ref, {
				from: offset,
				to: offset + node.nodeSize,
				text: node.textContent,
			});
		}
		index += 1;
	});
	return positions;
}