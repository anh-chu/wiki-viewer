/**
 * Exact-word comment highlighting.
 *
 * The bug these lock down was found live: a comment on "Reactions in app" inside
 * an ordered list painted only "Reactions ". The anchor's offsets describe the
 * BLOCK MARKDOWN (where a list item reads "2. Reactions in app"), while the
 * rendered node reads "Reactions in app" — so offset arithmetic highlighted the
 * wrong characters. These tests use a real ProseMirror document, because the
 * original failure was invisible when the doc was a structural stub.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { buildCommentDecorations } from "@/components/editor/extensions/comment-highlight";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		bulletList: { content: "listItem+", group: "block" },
		orderedList: { content: "listItem+", group: "block" },
		listItem: { content: "paragraph block*" },
		text: { group: "inline" },
	},
	marks: { bold: {} },
});

/** Build a doc from plain strings; each string is one top-level node. */
function paragraphs(...texts: string[]) {
	return schema.node(
		"doc",
		null,
		texts.map((t) => schema.node("paragraph", null, [schema.text(t)])),
	);
}

/** Build an ordered list whose items each hold one paragraph. */
function orderedList(...items: string[]) {
	return schema.node("doc", null, [
		schema.node(
			"orderedList",
			null,
			items.map((t) => schema.node("listItem", null, [schema.node("paragraph", null, [schema.text(t)])])),
		),
	]);
}

function commentFor(ref: string, selectedText: string, start: number, end?: number) {
	return {
		id: `c-${ref}-${start}`,
		ref,
		resolved: false,
		createdAt: "",
		turns: [],
		textAnchor: { start, end: end ?? start + selectedText.length, selectedText },
	};
}

/** Decorate, then read back what the decorations actually cover in the doc. */
function covered(doc: ReturnType<typeof paragraphs>, comments: unknown[]) {
	const set = buildCommentDecorations(doc as never, [], comments as never);
	return set.find().map((d) => doc.textBetween(d.from, d.to));
}

describe("exact-word comment highlights", () => {
	test("highlights only the commented words, not the block", () => {
		const doc = paragraphs("The quick brown fox jumps");
		const out = covered(doc, [commentFor("b1", "brown fox", 10)]);
		assert.deepEqual(out, ["brown fox"]);
	});

	test("REGRESSION: a list item is not offset by its markdown prefix", () => {
		// Live failure: anchor offsets came from "2. Reactions in app" (start 27),
		// but the rendered item text is "Reactions in app". Offsets must not be
		// trusted across that difference.
		const doc = orderedList("Non-product surveys", "Reactions in app");
		const out = covered(doc, [commentFor("b483fa8", "Reactions in app", 27, 43)]);
		assert.deepEqual(out, ["Reactions in app"], "must not paint 'Reactions ' alone");
	});

	test("a single-word anchor inside a list item is exact", () => {
		const doc = orderedList("Non-product surveys", "Reactions in app");
		const out = covered(doc, [commentFor("b1", "surveys", 96, 104)]);
		assert.deepEqual(out, ["surveys"], "must not paint 'ys'");
	});

	test("the recovered flag distinguishes search hits from offset hits", () => {
		// Anchor offsets are recorded against BLOCK MARKDOWN, so they legitimately
		// differ from document positions by the block's structural prefix. The flag
		// therefore means "found by searching after the text moved", not "offsets are
		// numerically equal" — and a moved anchor is exactly what must be visible, so
		// that a reader can tell the comment followed its text.
		const doc = paragraphs("Preface. The brown fox");

		// Same text, offsets taken from a string the text no longer matches.
		const moved = buildCommentDecorations(
			doc as never,
			[],
			[commentFor("b1", "brown fox", 10, 19)] as never,
		).find();
		assert.equal(moved.length, 1);
		const movedAttrs = (moved[0] as { type?: { attrs?: Record<string, string> } }).type?.attrs;
		assert.equal(movedAttrs?.["data-comment-recovered"], "true", "text was found by search");

		// Nothing moved: offsets index the phrase exactly, so the hit is not "recovered".
		const still = buildCommentDecorations(
			doc as never,
			[],
			[commentFor("b1", "brown fox", 14, 23)] as never,
		).find();
		assert.equal(still.length, 1);
		const stillAttrs = (still[0] as { type?: { attrs?: Record<string, string> } }).type?.attrs;
		assert.notEqual(stillAttrs?.["data-comment-recovered"], "true", "offsets landed exactly");
		assert.equal(doc.textBetween(still[0].from, still[0].to), "brown fox");
	});

	test("a phrase spanning styled text is highlighted as one range", () => {
		const doc = schema.node("doc", null, [
			schema.node("paragraph", null, [
				schema.text("The quick "),
				schema.text("brown", [schema.mark("bold")]),
				schema.text(" fox"),
			]),
		]);
		const out = covered(doc as never, [commentFor("b1", "brown fox", 10, 19)]);
		assert.deepEqual(out, ["brown fox"]);
	});

	test("a match never crosses a block boundary", () => {
		// "fox" ends block 1 and "The" starts block 2; "foxThe" must not match.
		const doc = paragraphs("jumps over the fox", "The quick");
		const out = covered(doc, [commentFor("b1", "foxThe", 0, 6)]);
		assert.deepEqual(out, [], "must not join text across blocks");
	});

	test("a resolved comment draws nothing", () => {
		const doc = paragraphs("The quick brown fox");
		const c = commentFor("b1", "brown fox", 10);
		const out = covered(doc, [{ ...c, resolved: true }]);
		assert.deepEqual(out, []);
	});

	test("a stale comment draws nothing", () => {
		const doc = paragraphs("The quick brown fox");
		const c = commentFor("b1", "brown fox", 10);
		const out = covered(doc, [{ ...c, stale: true }]);
		assert.deepEqual(out, []);
	});

	test("a comment whose text is gone draws nothing rather than guessing", () => {
		const doc = paragraphs("The quick brown fox");
		const out = covered(doc, [commentFor("b1", "purple elephant", 10, 25)]);
		assert.deepEqual(out, [], "missing text must not become a misplaced highlight");
	});

	test("two comments on the same block both highlight", () => {
		const doc = paragraphs("The quick brown fox jumps");
		const out = covered(doc, [
			commentFor("b1", "quick", 4, 9),
			commentFor("b1", "fox", 16, 19),
		]);
		assert.deepEqual(out.sort(), ["fox", "quick"]);
	});

	test("a comment on a later block highlights in that block, not the first", () => {
		const doc = paragraphs("First paragraph", "Second paragraph");
		const out = covered(doc, [commentFor("b2", "Second", 0, 6)]);
		assert.deepEqual(out, ["Second"]);
	});
});