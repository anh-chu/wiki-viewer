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

test("repro-pip-consistency: identity mapping is what makes the pips line up", () => {
	// The user symptom this covers: "3 comments on 3 blocks → only 1 pip renders."
	//
	// An earlier version of this test hand-built a children array containing two
	// unstamped `<li>` elements as TOP-LEVEL siblings of the `<ul>`. That cannot
	// happen: ProseMirror renders list items inside the list, and the editor reads
	// only direct children (`Array.from(proseMirror.children)`), so the `<li>`s were
	// never candidates. The test asserted a scenario the DOM cannot produce, and it
	// needed `alignByIndex` — a second copy of the old loop, kept alive solely to be
	// its foil — to do it. Both are gone.
	//
	// What is real, and what the mapping actually has to survive: a block whose
	// element is present but UNSTAMPED, and a block whose element has not rendered
	// yet. Those are the shapes that produced missing and misplaced pips.
	const snapshotBlocks = [
		{ ref: "b111111" }, // para
		{ ref: "b222222" }, // loose list — ONE top-level node, however many items
		{ ref: "b333333" }, // para
	];

	// Direct children only: para, ul (unstamped because the stamp pass had not run),
	// para. Three elements, three blocks.
	const children = [
		el("b111111", 0),
		el(null, 100), // the list element, not yet stamped
		el("b333333", 200),
	];

	const fixed = alignByStampedRef(children, snapshotBlocks);

	// The two stamped blocks resolve by identity, so their pips land on the right
	// elements no matter what sits between them.
	assert.equal(fixed.positions.get("b111111")?.top, 0);
	assert.equal(fixed.positions.get("b333333")?.top, 200, "the pip is not shifted by the gap");

	// The unstamped block is reported rather than guessed at. Positional matching
	// would have claimed it mapped to the element at index 1 and drawn a pip that
	// looked correct while pointing at an element it never verified.
	assert.deepEqual(
		fixed.unmatchedRefs,
		["b222222"],
		"an unstamped block is surfaced, not silently given a neighbour's position",
	);
	assert.equal(fixed.orphanElements, 1, "and the unstamped element is counted");
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