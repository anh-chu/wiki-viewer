/**
 * PHASE 1 REPRO #4 — comments must anchor to an exact text range.
 *
 * User symptom: "Block commenting loses fidelity" — a comment pips to a whole
 * block and there is NO highlight of the specific commented text.
 *
 * DIAGNOSIS: not a bug, a missing capability. `Comment.ref` is block-scoped
 * (`types.ts:55`); `lineAnchor` exists only for the source viewer. The data
 * model has no way to express "these words". `docs/ux-contracts.md` §5.1
 * therefore *claims* exact-text hover highlight that the model cannot fulfil.
 *
 * These tests pin (a) the current block-granular limitation, and (b) the Phase 2
 * acceptance criteria for a range-carrying comment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	commentAnchorFidelity,
	type CommentAnchorInput,
} from "../../lib/proof/comment-anchor.js";

test("repro-comment-range: a block-only comment cannot highlight specific text (current model)", () => {
	const blockComment: CommentAnchorInput = {
		ref: "b123456",
		// No range, no selected text — the only anchor is the block.
	};

	const fidelity = commentAnchorFidelity(blockComment);

	assert.equal(
		fidelity.granularity,
		"block",
		"DOCUMENTS CURRENT BEHAVIOUR (DoD #1): a ref-only comment is block-granular",
	);
	assert.equal(
		fidelity.canHighlightExactText,
		false,
		"BUG (DoD #1): no text range exists, so the specific commented words cannot be highlighted",
	);
	assert.equal(
		fidelity.highlightLength,
		null,
		"the highlight length is unknown — it falls back to the whole block",
	);
});

test("repro-comment-range: a range-carrying comment highlights the exact selected text", () => {
	// Phase 2 target shape: the anchor carries the exact selected text plus the
	// range offsets within the block.
	const ranged: CommentAnchorInput = {
		ref: "b123456",
		range: { start: 4, end: 15 },
		selectedText: "quick brown",
		blockMarkdown: "The quick brown fox",
	};

	const fidelity = commentAnchorFidelity(ranged);

	assert.equal(fidelity.granularity, "range", "a range comment is text-granular");
	assert.equal(fidelity.canHighlightExactText, true, "DoD #1: exact text is highlightable");
	assert.equal(fidelity.highlightLength, 11, "highlight covers exactly the selected span");
	assert.equal(fidelity.selectedText, "quick brown");
});

test("repro-comment-range: the range must agree with the stored selected text", () => {
	// A range whose offsets do not reproduce selectedText is corrupt; surface it
	// rather than rendering a wrong highlight.
	const mismatched: CommentAnchorInput = {
		ref: "b123456",
		range: { start: 4, end: 15 },
		selectedText: "lazy dog",
		blockMarkdown: "The quick brown fox",
	};

	const fidelity = commentAnchorFidelity(mismatched);
	assert.equal(
		fidelity.consistent,
		false,
		"offsets disagreeing with selectedText must be flagged, not silently rendered",
	);
});

test("repro-comment-range: a range beyond the block length is rejected", () => {
	const outOfBounds: CommentAnchorInput = {
		ref: "b123456",
		range: { start: 4, end: 999 },
		selectedText: "nope",
		blockMarkdown: "The quick brown fox",
	};
	const fidelity = commentAnchorFidelity(outOfBounds);
	assert.equal(fidelity.consistent, false, "out-of-bounds ranges are not accepted");
	assert.equal(fidelity.canHighlightExactText, false, "and they do not produce a highlight");
});

test("repro-comment-range: selected text is recoverable when offsets have drifted", () => {
	// After a nearby edit the offsets may be stale, but the selected TEXT still
	// lets the anchor be re-resolved. This is the property that makes recovery
	// possible at all (DoD #6) — a bare hash could never be searched for.
	const drifted: CommentAnchorInput = {
		ref: "b123456",
		range: { start: 0, end: 11 },
		selectedText: "quick brown",
		blockMarkdown: "Well, the quick brown fox", // text moved
	};
	const fidelity = commentAnchorFidelity(drifted);
	assert.equal(
		fidelity.recoverableByText,
		true,
		"storing selectedText makes re-anchoring possible; a truncated hash would not",
	);
});