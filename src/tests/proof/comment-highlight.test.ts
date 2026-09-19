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

/**
 * One `{ref, markdown}` entry per top-level node, in document order.
 *
 * This mirrors what the editor hands the decorator: `snapshotBlocks`, whose order the
 * editor stamps onto top-level children index-for-index as `data-block-ref`. Tests that
 * passed `[]` were not exercising the scoping path at all.
 */
function blocksFor(doc: ReturnType<typeof paragraphs>) {
	const blocks: { ref: string; markdown: string }[] = [];
	doc.forEach((node) => {
		blocks.push({ ref: `blk${blocks.length}`, markdown: node.textContent });
	});
	return blocks;
}

/** Decorate, then read back what the decorations actually cover in the doc. */
function covered(doc: ReturnType<typeof paragraphs>, comments: unknown[]) {
	const set = buildCommentDecorations(doc as never, blocksFor(doc), comments as never);
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

	test("a phrase in two blocks highlights the block that was commented on", () => {
		// The defect a reviewer found: the search was document-global and returned the
		// FIRST `indexOf` hit, so a comment on the second of two identical paragraphs
		// always painted the first. `comment.ref` is what says which block is meant,
		// and it was accepted as `_blocks` and never used.
		//
		// Ref names here are assigned positionally by the decorator, so the second
		// paragraph is addressed by an index no earlier block claims.
		const doc = paragraphs("The target word.", "The target word.");
		const out = covered(doc, [commentFor("blk1", "target", 4, 10)]);
		assert.deepEqual(out, ["target"], "one range, and the right one");
	});

	test("CONTROL: two comments on two identical blocks stay distinct", () => {
		// Without scoping both comments resolve to the same first hit, so the count
		// would still be 2 while the positions collapsed onto one another. Asserting
		// distinct offsets is what makes the scoping real.
		const doc = paragraphs("The target word.", "The target word.");
		const found = buildCommentDecorations(
			doc as never,
			blocksFor(doc),
			[
				commentFor("blk0", "target", 5, 11),
				commentFor("blk1", "target", 5, 11),
			] as never,
		).find();
		const ranges = found.map((d) => `${d.from}-${d.to}`);
		assert.equal(ranges.length, 2, "both comments are drawn");
		assert.notEqual(ranges[0], ranges[1], "and they must not land on the same words");
		// Both must still cover the phrase itself.
		for (const d of found) {
			assert.equal(doc.textBetween(d.from, d.to), "target");
		}
	});

	test("a match inside the block is reported as a match, not a recovery", () => {
		// The old "recovered" flag compared a block-local markdown offset against a
		// document-global position — different coordinate systems, so the comparison
		// could never legitimately succeed and the flag carried no information.
		const doc = paragraphs("Preface. The brown fox");
		const found = buildCommentDecorations(
			doc as never,
			[],
			[commentFor("b1", "brown fox", 10, 19)] as never,
		).find();
		assert.equal(found.length, 1);
		assert.equal(doc.textBetween(found[0].from, found[0].to), "brown fox");
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
describe("a block comment with no text anchor", () => {
	/**
	 * Found by looking at the rendered page, not at the DOM.
	 *
	 * A comment carries a `textAnchor` only when its author had a selection; the UI
	 * sends none for a plain block comment. The decorator required an anchor and
	 * `continue`d without one, so such a comment showed a card in the margin and an
	 * icon beside the paragraph while highlighting NOTHING in the text. Two comments in
	 * the same document therefore looked different for no reason the reader could see:
	 * the selected one was underlined, the block one was invisible.
	 *
	 * Google Docs marks the whole block in this case, which is what these pin.
	 */
	function blockComment(ref: string) {
		return { id: `c-${ref}-block`, ref, resolved: false, createdAt: "", turns: [] };
	}

	test("marks the commented block instead of nothing", () => {
		const doc = paragraphs("Alpha paragraph here.", "Beta paragraph here.");
		const out = covered(doc, [blockComment("blk0")]);
		assert.deepEqual(out, ["Alpha paragraph here."], "the block it is about, and only that");
	});

	test("does not bleed into the neighbouring block", () => {
		const doc = paragraphs("Alpha paragraph here.", "Beta paragraph here.");
		const out = covered(doc, [blockComment("blk1")]);
		assert.deepEqual(out, ["Beta paragraph here."], "the second block, not the first");
	});

	test("an anchored comment on the same block still highlights just its words", () => {
		// The fallback must not widen an existing anchor into a whole-block mark.
		const doc = paragraphs("Alpha paragraph here.");
		const out = covered(doc, [commentFor("blk0", "paragraph", 6)]);
		assert.deepEqual(out, ["paragraph"], "the anchor is still honoured");
	});

	test("resolved and stale comments still highlight nothing", () => {
		const doc = paragraphs("Alpha paragraph here.");
		const resolved = { ...blockComment("blk0"), resolved: true };
		const stale = { ...blockComment("blk0"), stale: true };
		assert.deepEqual(covered(doc, [resolved]), []);
		assert.deepEqual(covered(doc, [stale]), []);
	});
});

describe("ref aliasing when a block is edited", () => {
	/**
	 * Refs are content-derived (`b` + sha256(markdown)), so editing a block changes its
	 * ref. `computeRefDelta` only aliased when a hash MOVED, so a block that was edited
	 * in place got no alias and every annotation on it was orphaned the instant the user
	 * typed — the sidecar still held the comment or suggestion, but its ref no longer
	 * existed in the document. Observed live as suggestions disappearing after typing.
	 *
	 * These pin the recovery AND its limits: position may only adopt a ref that is
	 * genuinely gone, or an annotation would be dragged onto unrelated text.
	 */
	async function delta(before: string, after: string, oldOrderOverride?: string[]) {
		const { assignRefs, computeRefDelta } = await import("@/lib/proof/block-refs");
		const { parseBlocks } = await import("@/lib/proof/blocks");
		const { blocks: b1, newRefMap: m1 } = assignRefs(parseBlocks(before), null);
		const { blocks: b2 } = assignRefs(parseBlocks(after), null);
		const hashToRef = new Map<string, string>();
		for (const [ref, e] of Object.entries(m1)) {
			if (!hashToRef.has(e.textHash)) hashToRef.set(e.textHash, ref);
		}
		return {
			oldRefs: b1.map((b) => b.ref),
			newRefs: b2.map((b) => b.ref),
			aliases: computeRefDelta(m1, hashToRef, b2, oldOrderOverride ?? Object.keys(m1)).refAliases,
		};
	}

	test("an edited block aliases its old ref", async () => {
		const { oldRefs, newRefs, aliases } = await delta(
			"Alpha paragraph here.\n",
			"Alpha paragraph here.XYZ\n",
		);
		assert.equal(aliases[oldRefs[0]], newRefs[0], "the annotation follows the edit");
	});

	test("only the edited block is aliased, not its neighbours", async () => {
		const { oldRefs, aliases } = await delta(
			"Alpha paragraph here.\n\nBeta paragraph here.\n",
			"Alpha paragraph here.XYZ\n\nBeta paragraph here.\n",
		);
		assert.equal(Object.keys(aliases).length, 1, "one edit, one alias");
		assert.ok(aliases[oldRefs[0]], "the block that changed");
		assert.equal(aliases[oldRefs[1]], undefined, "the untouched neighbour keeps its ref");
	});

	test("an insertion at the front does not alias the following block", async () => {
		// A new first block pushes the others down. Their refs still exist, so they are
		// NOT aliased — a positional alias here would point a comment at the new block.
		const { aliases } = await delta(
			"Alpha paragraph here.\n",
			"Brand new first block.\n\nAlpha paragraph here.\n",
		);
		assert.deepEqual(aliases, {}, "an insertion is not an edit");
	});

	test("a reordering moves content but does not alias across blocks", async () => {
		const { aliases } = await delta(
			"Alpha paragraph here.\n\nBeta paragraph here.\n",
			"Beta paragraph here.\n\nAlpha paragraph here.\n",
		);
		// Both refs survive (their content moved), so nothing is orphaned to recover.
		assert.deepEqual(aliases, {});
	});
});
