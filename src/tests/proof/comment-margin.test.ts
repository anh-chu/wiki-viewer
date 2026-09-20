/**
 * Comment margin layout.
 *
 * The non-trivial part is collision: two comments on adjacent lines must not
 * overlap, or the column becomes unreadable exactly when a document is most
 * heavily annotated. These assert the push-down behaviour and, as a control, the
 * naive behaviour it replaces.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { __test } from "@/components/editor/comment-margin";

const { layout } = __test;

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);
const MARGIN = readFileSync(
	new URL("../../components/editor/comment-margin.tsx", import.meta.url),
	"utf8",
);

function thread(blockRef: string) {
	return { blockRef, comments: [] as never[] };
}

describe("comment margin layout", () => {
	test("a single card sits at its anchor", () => {
		const out = layout([thread("a")], [], new Map([["a", 120]]), { a: 72 });
		assert.equal(out.length, 1);
		assert.equal(out[0].top, 120);
	});

	test("cards far apart keep their anchors", () => {
		const out = layout(
			[thread("a"), thread("b")],
			[],
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
			[],
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
			[],
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
			[],
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
			[],
			new Map([
				["a", 0],
				["b", 400],
			]),
			{ a: 72, b: 72 },
		);
		assert.deepEqual(
			out.map((o) => o.key),
			["a", "b"],
		);
	});

	test("an unknown anchor offset defaults to the top rather than vanishing", () => {
		const out = layout([thread("ghost")], [], new Map(), { ghost: 72 });
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
		const collapsed = layout(threads, [], offsets, { a: 55, b: 55, c: 55 });
		assert.equal(collapsed[0].top, 0);
		assert.equal(collapsed[1].top, 63);

		// Expanded: the first card grew. Every later card must move DOWN, and none
		// may start before the previous card ends.
		const expanded = layout(threads, [], offsets, { a: 185, b: 55, c: 55 });
		for (let i = 1; i < expanded.length; i++) {
			const prev = expanded[i - 1];
			const prevEnd = prev.top + (prev.key === "a" ? 185 : 55);
			assert.ok(
				expanded[i].top >= prevEnd + 8,
				`card ${expanded[i].key} at ${expanded[i].top} overlaps the ` +
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
		const stale = layout(threads, [], offsets, { a: 55, b: 55 });
		const realEndOfA = 0 + 185;
		assert.ok(
			stale[1].top < realEndOfA,
			`with the stale height the second card starts at ${stale[1].top}, inside ` +
				`the expanded card's body (which runs to ${realEndOfA})`,
		);
	});
});

describe("suggestion cards share the comment column's collision pass", () => {
	// A suggested change is a mark in the document, and the reviewer settles it from
	// the margin — so its card occupies the same column as a comment card. Two
	// independent layouts would let a comment and a suggestion anchored to the same
	// line print on top of each other, which is the failure this column exists to
	// prevent.

	test("a suggestion and a comment on the same line do not overlap", () => {
		const threads = [thread("a")];
		const offsets = new Map([["a", 0]]);
		const laid = layout(
			threads,
			[suggestion(1, "a", 0)],
			offsets,
			{ a: 72, "suggestion:1": 84 },
		);

		assert.equal(laid.length, 2, "both kinds of card must be laid out");
		const [first, second] = laid;
		const firstEnd = first.top + (first.thread ? 72 : 84);
		assert.ok(
			second.top >= firstEnd,
			`the second card starts at ${second.top}, inside the first card ending at ${firstEnd}`,
		);
	});

	test("cards are ordered by their anchor position, not by kind", () => {
		const threads = [thread("b")];
		const offsets = new Map([
			["b", 400],
			["a", 10],
		]);
		const laid = layout(threads, [suggestion(9, "a", 10)], offsets, { b: 72 });

		assert.deepEqual(
			laid.map((c) => c.key),
			["suggestion:9", "b"],
			"the suggestion sits above, because its mark is above the comment's block",
		);
	});

	test("a suggestion card carries no thread, so the render can branch on it", () => {
		// The render picks the card by testing `thread` first, then `suggestion`. If a
		// suggestion ever arrived with a thread attached it would render as a comment,
		// showing an author that does not exist.
		const laid = layout([], [suggestion(1, "a", 0)], new Map([["a", 0]]), {});
		assert.equal(laid.length, 1);
		assert.equal(laid[0].thread, null);
		assert.ok(laid[0].suggestion, "the suggestion must ride on its own field");
	});

	test("a suggestion with no resolvable block is placed at the top, not dropped", () => {
		// A mark whose block could not be resolved still has to be reviewable, or the
		// change cannot be settled from the only surface that can settle it.
		const laid = layout([], [suggestion(1, null, 0)], new Map(), {});
		assert.equal(laid.length, 1, "an unanchorable change must still be shown");
		assert.equal(laid[0].top, 0);
	});
});

function suggestion(id: number, blockRef: string | null, from: number) {
	return {
		id,
		kind: "insert" as const,
		from,
		to: from + 4,
		text: "word",
		blockRef,
	};
}

describe("the first card clears the tab header", () => {
	// Regression the user caught twice. The card offsets are measured from the SCROLL
	// CONTAINER, but the cards render in a box that begins BELOW the panel's tab
	// header. The column is therefore high by exactly the header's height, and the
	// topmost card sits on the tabs. My first attempt added 8px of CSS padding, which
	// does not address the mismatch at all — it was a guess dressed as a fix.

	test("layout shifts every card by the inset", () => {
		const threads = [thread("a"), thread("b")];
		const offsets = new Map([
			["a", 0],
			["b", 63],
		]);
		const INSET = 41;
		const laid = layout(threads, [], offsets, { a: 55, b: 55 }, INSET);

		assert.equal(laid[0].top, INSET, "the first card must clear the header");
		assert.ok(
			laid[1].top >= laid[0].top + 55 + 8,
			"and the collision pass must still hold with the inset applied",
		);
	});

	test("the panel reads offsets in the VIEWPORT frame, not the scroll-content one", () => {
		// The real bug behind the reported drift, and it was much larger than a gap.
		// `blockRefPositions.top` includes `scrollTop` — correct for the pips, which live
		// INSIDE the scrolling element and must move with the text. The panel is a sibling
		// of that element and does not move with the text, so content coordinates made
		// every card drift down by the scrolled amount.
		assert.match(
			EDITOR,
			/map\.set\(ref, pos\.viewportTop \?\? pos\.top\);/,
			"the panel must use the viewport-frame offset",
		);
		// And the pips must keep the content frame: changing them would break what works.
		assert.match(
			EDITOR,
			/top: rect\.top - containerRect\.top \+ container\.scrollTop,/,
			"the pip offsets must still include the scroll term",
		);
	});

	test("both frames come from one measurement", () => {
		// Two independent rects could disagree about which revision of the layout they
		// describe; deriving both from the same rect makes that impossible.
		assert.match(
			EDITOR,
			/viewportTop: rect\.top - containerRect\.top,/,
			"viewportTop must be the same rect minus the scroll term",
		);
	});

	test("the inset is the header height alone, never header + gap", () => {
		// Regression: the first version added CARD_GAP on top of the header height, so
		// every card sat 8px lower than its text. Visible in a screenshot against a
		// short anchor, where the card reads as belonging to the line below.
		const MARGIN = readFileSync(
			new URL("../../components/editor/comment-margin.tsx", import.meta.url),
			"utf8",
		);
		assert.ok(
			!/headerHeight \+/.test(MARGIN),
			"nothing may be added to the header height",
		);
		assert.match(MARGIN, /-headerHeight/, "it must be subtracted, not added");
	});

	test("the inset does not change the spacing BETWEEN cards", () => {
		// It shifts the column, it does not stretch it: a second magic number here is
		// how two cards drift apart only when a header is present.
		const threads = [thread("a"), thread("b")];
		const offsets = new Map([
			["a", 100],
			["b", 200],
		]);
		const noInset = layout(threads, [], offsets, { a: 55, b: 55 });
		const withInset = layout(threads, [], offsets, { a: 55, b: 55 }, 41);
		assert.equal(
			withInset[1].top - withInset[0].top,
			noInset[1].top - noInset[0].top,
			"the gap between two cards must be identical either way",
		);
	});

	test("the inset applies to suggestion cards too", () => {
		// Both kinds share the column, so a suggestion left un-shifted would overlap
		// the tabs while the comments below it did not.
		const laid = layout([], [suggestion(1, "a", 0)], new Map([["a", 0]]), {}, 41);
		assert.equal(laid[0].top, 41);
	});

	test("the inset is the measured header height, not a constant", () => {
		// The header's height depends on font metrics and on whether counts render, so
		// a hardcoded number would be wrong on another machine by a few pixels — enough
		// to overlap or to leave a visible gap.
		const MARGIN = readFileSync(
			new URL("../../components/editor/comment-margin.tsx", import.meta.url),
			"utf8",
		);
		assert.match(MARGIN, /ResizeObserver/, "the header must be measured, not assumed");
		// Verified against the live DOM: with `+headerHeight` every card measured exactly
		// 51px below its commented phrase, and with `-headerHeight` it lands on the line
		// box (5px above the phrase, which is the paragraph's first-line leading).
		assert.match(
			MARGIN,
			/\t\t-headerHeight,/,
			"the header must be SUBTRACTED: the card area already starts below it",
		);
		assert.ok(
			!/headerHeight \+ CARD_GAP|headerHeight \+ BODY_GAP/.test(MARGIN),
			"NOT header + a gap: the extra gap pushed every card an additional 8px " +
				"below the text it annotates, which is visible against a short anchor",
		);
		assert.ok(
			!/paddingTop: headerHeight/.test(MARGIN),
			"it must NOT be CSS padding: that shrinks the scrollable box and puts the " +
				"last card out of reach",
		);
	});
});

describe("the offsets are re-measured when the layout reflows", () => {
	// Found by measuring the live DOM: with the panel open every card sat exactly 37px
	// above its text. The cause was not arithmetic but STALENESS — the block offsets are
	// pixel positions captured once, and opening the panel narrows the reading column,
	// so paragraphs wrap taller and every block below the first moves down. The editor
	// box keeps its own size, so no resize event fired and the stale offsets stood.

	test("the measurement depends on the panel, not only on the document", () => {
		const effect = EDITOR.slice(
			EDITOR.indexOf("Bumped whenever something reflows the text"),
			EDITOR.indexOf("After content renders, walk"),
		);
		assert.ok(effect.length > 0, "expected the reflow key");
		assert.match(
			EDITOR,
			/\[panelOpen, tab, editorMaxW\]/,
			"opening the panel and changing the width must both re-measure",
		);
		assert.match(
			EDITOR,
			/\}, \[currentPath, snapshotBlockOffset, snapshotBlocks, reflowKey\]\);/,
			"and the measurement effect must consume that key",
		);
	});

	test("a resize observer covers the reflows the key cannot see", () => {
		// Window resizes and fonts landing also move blocks, and neither bumps the key.
		assert.match(EDITOR, /new ResizeObserver/, "a resize observer must exist");
		assert.match(
			EDITOR,
			/observer\.observe\(container\)/,
			"it must watch the CONTAINER: the editor box itself keeps its size when the " +
				"reading column narrows, so observing only that would never fire",
		);
	});
});
