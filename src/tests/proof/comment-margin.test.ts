/**
 * Comment margin layout.
 *
 * The non-trivial part is collision: two comments on adjacent lines must not
 * overlap, or the column becomes unreadable exactly when a document is most
 * heavily annotated. These assert the push-down behaviour and, as a control, the
 * naive behaviour it replaces.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { __test } from "@/components/editor/comment-margin";

const { layout } = __test;

function thread(blockRef: string) {
	return { blockRef, comments: [] as never[] };
}

describe("comment margin layout", () => {
	test("a single card sits at its anchor", () => {
		const out = layout([thread("a")], new Map([["a", 120]]), { a: 72 });
		assert.equal(out.length, 1);
		assert.equal(out[0].top, 120);
	});

	test("cards far apart keep their anchors", () => {
		const out = layout(
			[thread("a"), thread("b")],
			new Map([
				["a", 0],
				["b", 400],
			]),
			{ a: 72, b: 72 },
		);
		assert.equal(out[0].top, 0);
		assert.equal(out[1].top, 400, "no push needed when there is room");
	});

	test("overlapping cards are pushed down, never stacked", () => {
		// a: 0..72, b wants 40 -> would overlap by 32.
		const out = layout(
			[thread("a"), thread("b")],
			new Map([
				["a", 0],
				["b", 40],
			]),
			{ a: 72, b: 72 },
		);
		assert.equal(out[0].top, 0);
		assert.equal(out[1].top, 72 + 8, "pushed to one gap below the first card");
	});

	test("a chain of adjacent anchors never overlaps", () => {
		// The realistic bad case: five comments on five consecutive lines.
		const refs = ["a", "b", "c", "d", "e"];
		const offsets = new Map(refs.map((r, i) => [r, i * 20]));
		const heights = Object.fromEntries(refs.map((r) => [r, 72]));
		const out = layout(
			refs.map(thread),
			offsets,
			heights,
		);

		for (let i = 1; i < out.length; i += 1) {
			const prevBottom = out[i - 1].top + heights[refs[i - 1]];
			assert.ok(
				out[i].top >= prevBottom,
				`card ${i} at ${out[i].top} must clear previous bottom ${prevBottom}`,
			);
		}
	});

	test("CONTROL: the naive layout DOES overlap, so the push-down earns its place", () => {
		// Without the collision pass every card would sit exactly at its anchor.
		const naive = [0, 40];
		const height = 72;
		assert.ok(
			naive[1] < naive[0] + height,
			"naive top-at-anchor layout overlaps — this is what layout() fixes",
		);
	});

	test("a tall card pushes the next one further", () => {
		const out = layout(
			[thread("a"), thread("b")],
			new Map([
				["a", 0],
				["b", 10],
			]),
			{ a: 300, b: 72 },
		);
		assert.equal(out[1].top, 300 + 8, "must clear the taller card, not a default height");
	});

	test("input order does not matter — output is sorted by anchor", () => {
		const out = layout(
			[thread("b"), thread("a")],
			new Map([
				["a", 0],
				["b", 400],
			]),
			{ a: 72, b: 72 },
		);
		assert.deepEqual(
			out.map((o) => o.thread.blockRef),
			["a", "b"],
		);
	});

	test("an unknown anchor offset defaults to the top rather than vanishing", () => {
		const out = layout([thread("ghost")], new Map(), { ghost: 72 });
		assert.equal(out.length, 1, "a card with no measured anchor is still shown");
		assert.equal(out[0].top, 0);
	});

	test("an EXPANDED card pushes the cards below it, using its grown height", () => {
		// Regression: heights were measured only when the visible set changed, so
		// expanding a card kept the collision pass on its COLLAPSED height. Measured
		// live, an expanded card spanning 45-230px had the next two printed at
		// 108-163 and 171-226 — on top of its body.
		//
		// The layout itself was always correct; the stale INPUT was the bug. So this
		// pins the invariant layout must honour once it is given the real height.
		const threads = [thread("a"), thread("b"), thread("c")];
		const offsets = new Map([
			["a", 0],
			["b", 63],
			["c", 126],
		]);

		// Collapsed: three 55px cards pack tightly.
		const collapsed = layout(threads, offsets, { a: 55, b: 55, c: 55 });
		assert.equal(collapsed[0].top, 0);
		assert.equal(collapsed[1].top, 63);

		// Expanded: the first card grew. Every later card must move DOWN, and none
		// may start before the previous card ends.
		const expanded = layout(threads, offsets, { a: 185, b: 55, c: 55 });
		for (let i = 1; i < expanded.length; i++) {
			const prev = expanded[i - 1];
			const prevEnd = prev.top + (prev.thread.blockRef === "a" ? 185 : 55);
			assert.ok(
				expanded[i].top >= prevEnd + 8,
				`card ${expanded[i].thread.blockRef} at ${expanded[i].top} overlaps the ` +
					`expanded card ending at ${prevEnd}`,
			);
		}
		assert.ok(
			expanded[1].top > collapsed[1].top,
			"growing the first card must push the second one down",
		);
	});

	test("CONTROL: stale collapsed heights DO cause overlap", () => {
		// Proves the assertion above is load-bearing: feeding the old 55px height for
		// a card that is really 185px reproduces the overlap exactly as it was seen
		// in the browser.
		const threads = [thread("a"), thread("b")];
		const offsets = new Map([
			["a", 0],
			["b", 63],
		]);
		const stale = layout(threads, offsets, { a: 55, b: 55 });
		const realEndOfA = 0 + 185;
		assert.ok(
			stale[1].top < realEndOfA,
			`with the stale height the second card starts at ${stale[1].top}, inside ` +
				`the expanded card's body (which runs to ${realEndOfA})`,
		);
	});
});
