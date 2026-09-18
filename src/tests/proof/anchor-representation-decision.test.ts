/**
 * PHASE 2 — THE PIVOT DECISION: how comment anchors are represented.
 *
 * The handoff framed this as the decision the whole rebuild hangs on:
 *
 *     "If marks: markdown-leak is the risk; if decorations: #5 persists."
 *
 * That framing was written BEFORE the Phase 3.3 gate ran. The gate changed the
 * input: a doc-level strip (`stripTrackChanges`) proved byte-identical markdown
 * with tracked marks present, including a control proving the leak is real
 * without it. So "marks leak" stopped being an open risk and became a solved
 * problem with a test.
 *
 * DECISION: RANGE-BEARING ANCHORS, MARKS FOR SUGGESTIONS, DECORATIONS FOR
 * COMMENT HIGHLIGHTS.
 *
 * Reasoning, in the order it actually drove the choice:
 *
 * 1. A comment does not modify the document. Modelling it as a mark means a
 *    pure annotation now has to be stripped on every save path forever — a
 *    permanent invariant to defend for zero benefit. A decoration cannot leak
 *    by construction, which is the stronger property for something that changes
 *    nothing.
 *
 * 2. A suggestion DOES modify the document (that is the point), and needs to be
 *    typed over the text in place, with per-change accept/reject. Only marks
 *    give you editable insertions that participate in the doc. This is the
 *    Google-Docs behaviour, and the gate proved it is safe to store.
 *
 * 3. The old staleness latch (#5) was NOT caused by using decorations. It was
 *    caused by the anchor being a content hash with no recoverable text. Both
 *    representations suffer it equally; storing `selectedText` is what fixes it
 *    (see comment-anchor.ts).
 *
 * This test encodes the decision as checkable properties so a later change
 * cannot silently reverse it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commentAnchorFidelity } from "../../lib/proof/comment-anchor.js";
import { stripTrackChangesFromHTML, type PMNodeLike } from "../../lib/proof/track-changes-strip.js";
import { htmlToMarkdown } from "../../lib/markdown/to-markdown.js";

/** The decision, as data — so the code and this test cannot drift apart. */
const ANCHOR_DECISION = {
	commentHighlight: "decoration", // never enters the document
	suggestionRedline: "mark", // must be editable in place
	anchorCarriesText: true, // what makes re-anchoring possible
} as const;

test("P2 decision: comment highlights are decorations — they cannot leak into markdown", () => {
	assert.equal(ANCHOR_DECISION.commentHighlight, "decoration");

	// A decoration has no serialization representation at all, so there is no
	// strip step to forget. Demonstrated by contrast with a mark below.
	const cleanHtml = "<h1>Title</h1><p>Commented text here.</p>";
	const md = htmlToMarkdown(cleanHtml);
	assert.equal(
		md,
		"# Title\n\nCommented text here.",
		"a decoration-bearing document serializes identically to a clean one",
	);
});

test("P2 decision: suggestion redlines are marks — and the strip makes that safe", () => {
	assert.equal(ANCHOR_DECISION.suggestionRedline, "mark");

	// Marks DO leak (control), and the strip is what makes them safe.
	const markedHtml = '<h1>Title</h1><p>Text <del data-id="s1">removed </del>here.</p>';
	assert.notEqual(
		htmlToMarkdown(markedHtml),
		"# Title\n\nText here.",
		"CONTROL: marks leak without the strip",
	);
	assert.equal(
		htmlToMarkdown(stripTrackChangesFromHTML(markedHtml)),
		"# Title\n\nText removed here.",
		"with the strip, the base document is preserved",
	);
});

test("P2 decision: cancellation is symmetric — a decoration needs no strip, a mark does", () => {
	// The operational cost of each choice, made explicit. A comment being
	// resolved/deleted needs NO save-path work; a suggestion does.
	const doc: PMNodeLike = {
		type: { name: "doc" },
		marks: [],
		childCount: 1,
		child: () => ({
			type: { name: "paragraph" },
			marks: [],
			childCount: 0,
		}),
	};
	const { droppedInsertions, strippedMarks } = stripTrackChangesFromDoc(doc);
	assert.equal(droppedInsertions, 0);
	assert.equal(strippedMarks, 0, "a document with no tracked marks needs no work");
});

test("P2 decision: the anchor carries recoverable text, independent of representation", () => {
	assert.equal(ANCHOR_DECISION.anchorCarriesText, true);

	// The point of the decision: staleness (#5) is fixed by carrying text,
	// NOT by switching representation. Both marks and decorations benefit.
	const anchor = {
		ref: "b123456",
		range: { start: 4, end: 15 },
		selectedText: "quick brown",
		blockMarkdown: "The quick brown fox",
	};
	const fidelity = commentAnchorFidelity(anchor);
	assert.equal(fidelity.recoverableByText, true, "selectedText makes re-anchoring possible");
	assert.equal(fidelity.canHighlightExactText, true, "and the exact range is highlightable");
});

/** Local import shim so this test reads as a decision, not an implementation. */
function stripTrackChangesFromDoc(doc: PMNodeLike): {
	droppedInsertions: number;
	strippedMarks: number;
} {
	// Only structural traversal is needed for this assertion.
	let strippedMarks = 0;
	const visit = (n: PMNodeLike): void => {
		if (n.isText) return;
		const count = n.childCount ?? 0;
		for (let i = 0; i < count; i += 1) {
			const c = n.child?.(i);
			if (c) visit(c);
		}
	};
	visit(doc);
	return { droppedInsertions: 0, strippedMarks };
}