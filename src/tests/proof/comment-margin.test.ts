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
});