/**
 * PHASE 4 acceptance — identity-keyed pip mapping and viewport-safe geometry.
 *
 * The handoff's Phase 4 asks for three things: delete the editor.tsx:493 index
 * loop, key pips on identity from `editor.state.doc`, and adopt Floating UI for
 * geometry instead of hand-rolled rect math.
 *
 * repro-pip-consistency.test.ts pins the mapping bug and its fix. This file
 * covers the geometry half and the fail-loudly requirement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { placePip, PIP_GUTTER_OFFSET } from "../../lib/proof/pip-geometry.js";
import { alignByStampedRef, type BlockElementLike } from "../../lib/proof/pip-alignment.js";

test("P4: a pip sits in the left gutter, vertically aligned with its block", () => {
	const placement = placePip(
		{ top: 120, left: 240, width: 600, bottom: 160 },
		1280,
	);
	assert.equal(placement.top, 120, "vertically aligned with the block top");
	assert.ok(placement.left < 240, "sits to the left of the block");
	assert.equal(placement.clamped, false, "no clamping needed on a wide viewport");
	assert.equal(placement.left, 240 - 28 - PIP_GUTTER_OFFSET / 2);
});

test("P4: on a narrow viewport the pip is clamped inside rather than off-screen", () => {
	// The old hand-rolled math produced left < 0 here, which is why pips
	// vanished on mobile — the bug behind 'inconsistent' pip rendering.
	const placement = placePip({ top: 40, left: 8, width: 320, bottom: 80 }, 360);
	assert.ok(placement.left >= 0, "never negative");
	assert.ok(placement.left + 28 <= 360, "never past the right edge");
	assert.equal(placement.clamped, true, "clamping is reported, not silent");
});

test("P4: a wide block never pushes the pip past the right edge", () => {
	const placement = placePip({ top: 0, left: 100, width: 1200, bottom: 40 }, 360);
	assert.ok(placement.left + 28 <= 360, "pip stays inside a viewport narrower than its block");
	assert.equal(placement.clamped, true);
});

test("P4: refined identity mapping walks the SHALLOWEST matching element", () => {
	// A nested list: the <ul> carries the ref, the <li>s do not. Both the list
	// and its items are direct children in some renderings, so the mapping must
	// not let an <li> claim the ref.
	const el = (ref: string | null, top: number): BlockElementLike => ({
		getAttribute: (name) => (name === "data-block-ref" ? ref : null),
		measure: () => ({ top, left: 0, width: 100, bottom: top + 20 }),
	});

	const children = [
		el("b111111", 0), // paragraph
		el("b222222", 100), // <ul> carrying the list ref
		el(null, 120), // <li> — must NOT be mapped
		el("b333333", 200), // paragraph
	];
	const snapshot = [{ ref: "b111111" }, { ref: "b222222" }, { ref: "b333333" }];

	const result = alignByStampedRef(children, snapshot);
	assert.equal(result.positions.size, 3, "all three commented blocks resolve");
	assert.equal(result.positions.get("b222222")?.top, 100, "the <ul>, not the <li>");
	assert.equal(result.orphanElements, 1, "the unstamped <li> is counted, not mapped");
	assert.deepEqual(result.unmatchedRefs, [], "nothing is silently unresolved");
});

test("P4: unresolved refs are surfaced for fail-loudly, not dropped", () => {
	// The old loop ended at Math.min and returned no signal at all. The contract
	// now is: unresolved refs come back in a list the caller can warn on.
	const el = (ref: string): BlockElementLike => ({
		getAttribute: (name) => (name === "data-block-ref" ? ref : null),
		measure: () => ({ top: 0, left: 0, width: 10, bottom: 10 }),
	});
	const result = alignByStampedRef(
		[el("b111111")],
		[{ ref: "b111111" }, { ref: "b222222" }, { ref: "b333333" }],
	);
	assert.deepEqual(
		result.unmatchedRefs,
		["b222222", "b333333"],
		"every unresolved annotated block is reported so dev builds can warn",
	);
});