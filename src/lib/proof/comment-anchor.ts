/**
 * Comment anchoring: fidelity assessment for a candidate anchor.
 *
 * WHY THIS EXISTS
 * ---------------
 * The current model anchors a comment to a BLOCK (`Comment.ref`, types.ts:55).
 * That cannot express "these specific words", so `docs/ux-contracts.md` §5.1
 * promised an exact-text hover highlight the data model could not deliver.
 *
 * Phase 2 adds a text range plus the selected text to the anchor. This module
 * is the pure assessment layer: given a candidate anchor it reports the
 * granularity, whether an exact highlight is possible, and — critically —
 * whether the anchor is *recoverable* from its stored text after edits move it.
 *
 * Why `selectedText` matters more than the offsets: offsets drift with every
 * nearby edit, but text can be searched for. The previous `LineAnchor.textHash`
 * could verify an anchor and never find it, which is what made the staleness
 * latch (DoD #6) unrecoverable.
 */

export interface AnchorRange {
	start: number;
	end: number;
}

export interface CommentAnchorInput {
	/** Block ref, always present. */
	ref?: string;
	/** Offsets within the block's markdown. */
	range?: AnchorRange;
	/** The exact text the user selected. Makes the anchor searchable. */
	selectedText?: string;
	/** Snapshot of the block markdown the range was computed against. */
	blockMarkdown?: string;
}

export type AnchorGranularity = "block" | "range";

export interface AnchorFidelity {
	granularity: AnchorGranularity;
	canHighlightExactText: boolean;
	/** Character length of the highlight, or null when block-granular. */
	highlightLength: number | null;
	/** The exact text, when the anchor carries one. */
	selectedText?: string;
	/** Do the offsets reproduce `selectedText` against `blockMarkdown`? */
	consistent: boolean;
	/** Can the anchor be re-found by searching for its text? */
	recoverableByText: boolean;
}

/**
 * Assess a candidate comment anchor.
 *
 * `consistent` is false when offsets and text disagree, or when the range runs
 * past the block. Callers must not render a highlight for an inconsistent
 * anchor — a wrong highlight is worse than none.
 */
export function commentAnchorFidelity(input: CommentAnchorInput): AnchorFidelity {
	const { range, selectedText, blockMarkdown } = input;

	// Block-granular: the legacy shape.
	if (!range || selectedText === undefined) {
		return {
			granularity: "block",
			canHighlightExactText: false,
			highlightLength: null,
			...(selectedText !== undefined ? { selectedText } : {}),
			consistent: !range,
			// Without stored text there is nothing to search for.
			recoverableByText: false,
		};
	}

	const inBounds =
		range.start >= 0 &&
		range.end >= range.start &&
		(blockMarkdown === undefined || range.end <= blockMarkdown.length);

	const extracted =
		blockMarkdown !== undefined && inBounds
			? blockMarkdown.slice(range.start, range.end)
			: undefined;

	const consistent = inBounds && (extracted === undefined || extracted === selectedText);

	return {
		granularity: "range",
		canHighlightExactText: consistent,
		highlightLength: consistent ? range.end - range.start : null,
		selectedText,
		consistent,
		// Text is searchable regardless of whether the offsets survived.
		recoverableByText: selectedText.length > 0,
	};
}