/**
 * PHASE 1 REPRO #1 — pip consistency.
 *
 * User symptom: "3 comments on 3 blocks → only 1 pip renders."
 *
 * Root cause (editor.tsx:493): DOM children were matched to `snapshotBlocks` by
 * ARRAY INDEX. mdast→Tiptap is not 1:1, so a loose list or blockquote shifts
 * every subsequent pairing, and `Math.min` silently truncated the remainder.
 *
 * These tests reproduce the symptom against the real alignment logic and pin
 * the corrected identity-keyed mapping. The pre-fix assertions FAIL on the old
 * index-based loop; the post-fix assertions are the acceptance criteria for
 * definition-of-done #4.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	alignByIndex,
	alignByStampedRef,
	type BlockElementLike,
} from "../../lib/proof/pip-alignment.js";

/** Build a fake element that reports its own identity and a distinct position. */
function el(ref: string | null, top: number): BlockElementLike {
	return {
		getAttribute: (name: string) =>
			name === "data-block-ref" ? ref : null,
		measure: () => ({ top, left: 0, width: 100, bottom: top + 20 }),
	};
}

test("repro-pip-consistency: index mapping misaligns when mdast expands to more DOM nodes than blocks", () => {
	// Source markdown: 3 blocks — para, loose list, para.
	// mdast gives 3 blocks, but the loose list renders as <ul> + 2 <li> = extra DOM nodes.
	const snapshotBlocks = [
		{ ref: "b111111" }, // para
		{ ref: "b222222" }, // loose list  (expands to 3 DOM children)
		{ ref: "b333333" }, // para
	];

	// Rendered DOM: para, ul, li, li, para  → 5 children for 3 blocks.
	const children = [
		el("b111111", 0), // para   ✔ aligns
		el("b222222", 100), // ul     ✔ aligns
		el(null, 200), // li     — no ref of its own
		el(null, 300), // li     — no ref of its own
		el("b333333", 400), // para   ✘ index says this is beyond the loop limit
	];

	// --- Legacy behaviour: reproduces the bug -------------------------------
	const legacy = alignByIndex(children, snapshotBlocks);
	assert.equal(
		legacy.size,
		3,
		"legacy loop truncates at Math.min(5, 3) = 3, so it claims all 3 blocks mapped",
	);
	// The third block IS present but its position came from children[2] (an <li>),
	// not from the real block element. That is the silent corruption.
	assert.equal(
		legacy.get("b333333")?.top,
		200,
		"BUG: b333333's position was taken from the wrong DOM node (an <li> at top=200)",
	);
	assert.notEqual(
		legacy.get("b333333")?.top,
		400,
		"BUG: correct position (400) is never read, so the pip renders in the wrong place",
	);

	// --- Fixed behaviour: identity-keyed -----------------------------------
	const fixed = alignByStampedRef(children, snapshotBlocks);
	assert.equal(fixed.positions.size, 3, "all three commented blocks resolve by identity");
	assert.equal(fixed.positions.get("b333333")?.top, 400, "b333333 gets its true element's position");
	assert.equal(fixed.positions.get("b222222")?.top, 100, "b222222 gets its true element's position");
	assert.deepEqual(fixed.unmatchedRefs, [], "no commented block is left unmapped");
	assert.equal(fixed.orphanElements, 2, "the two unstamped <li>s are counted, not silently skipped");
});

test("repro-pip-consistency: three comments on three simple blocks all produce a pip", () => {
	const snapshotBlocks = [{ ref: "b111111" }, { ref: "b222222" }, { ref: "b333333" }];
	const children = [el("b111111", 0), el("b222222", 100), el("b333333", 200)];

	const fixed = alignByStampedRef(children, snapshotBlocks);
	assert.equal(fixed.positions.size, 3, "3 comments on 3 blocks → 3 pips");
	assert.deepEqual(fixed.unmatchedRefs, []);
	assert.equal(fixed.orphanElements, 0);
});

test("repro-pip-consistency: an unmapped ref is surfaced rather than dropped", () => {
	// The real element never rendered (e.g. still mid-refresh). The old loop
	// returned nothing for it and no signal; the new path reports it.
	const snapshotBlocks = [{ ref: "b111111" }, { ref: "b222222" }];
	const children = [el("b111111", 0)];

	const fixed = alignByStampedRef(children, snapshotBlocks);
	assert.deepEqual(
		fixed.unmatchedRefs,
		["b222222"],
		"the missing ref is reported so the UI can fail loudly instead of vanishing",
	);
});

test("repro-pip-consistency: snapshotBlockOffset (frontmatter) is honoured", () => {
	// Viewing mode renders frontmatter outside ProseMirror, so the first N
	// snapshot blocks legitimately have no element.
	const snapshotBlocks = [
		{ ref: "bfront1" }, // frontmatter — outside .ProseMirror
		{ ref: "b222222" },
		{ ref: "b333333" },
	];
	const children = [el("b222222", 0), el("b333333", 100)];

	const fixed = alignByStampedRef(children, snapshotBlocks, 1);
	assert.equal(fixed.positions.size, 2);
	assert.deepEqual(fixed.unmatchedRefs, [], "frontmatter is not reported as unmatched");
});