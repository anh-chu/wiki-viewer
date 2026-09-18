/**
 * Accepting and rejecting tracked changes.
 *
 * These are the transforms behind the two buttons a reviewer presses, so they are
 * tested directly rather than through the editor UI: a wrong accept silently
 * rewrites the document the user signed off on.
 *
 * The definitions, matching Google Docs:
 *   - accept: inserted text stays, deleted text goes, formatting changes stick
 *   - reject: inserted text goes, deleted text comes back
 *
 * The subtle part is ordering. Removing a range shifts every later position, so
 * multi-range operations must be applied last-to-first or the second removal
 * deletes the wrong words.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import {
	applyAccept,
	applyReject,
	collectTrackedRanges,
} from "@/components/editor/extensions/track-changes-behavior";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		text: { group: "inline" },
	},
	marks: {
		insertion: { attrs: { by: { default: null }, at: { default: null } } },
		deletion: { attrs: { by: { default: null }, at: { default: null } } },
		modification: { attrs: { by: { default: null }, at: { default: null } } },
	},
});

/** Build a paragraph from [text, markName|null] runs. */
function para(runs: [string, string | null][]) {
	return schema.node(
		"paragraph",
		null,
		runs.map(([text, mark]) =>
			schema.text(
				text,
				mark ? [schema.marks[mark].create({ by: "human" })] : undefined,
			),
		),
	);
}

function stateOf(runs: [string, string | null][]) {
	return EditorState.create({ doc: schema.node("doc", null, [para(runs)]) });
}

/** Apply a transform and return the resulting plain text. */
function textAfter(state: EditorState, tr: ReturnType<typeof applyAccept>) {
	assert.ok(tr, "expected a transaction");
	return tr.doc.textContent;
}

describe("accepting tracked changes", () => {
	test("an insertion is kept", () => {
		const state = stateOf([
			["The fox", null],
			[" jumps", "insertion"],
		]);
		assert.equal(textAfter(state, applyAccept(state)), "The fox jumps");
	});

	test("a deletion is removed", () => {
		const state = stateOf([
			["The quick", null],
			[" brown", "deletion"],
			[" fox", null],
		]);
		assert.equal(textAfter(state, applyAccept(state)), "The quick fox");
	});

	test("a replacement keeps the new text and drops the old", () => {
		// "quick" struck through, "fast" inserted: the Docs replace gesture.
		const state = stateOf([
			["The ", null],
			["quick", "deletion"],
			["fast", "insertion"],
			[" fox", null],
		]);
		assert.equal(textAfter(state, applyAccept(state)), "The fast fox");
	});

	test("a formatting-only change keeps the text", () => {
		const state = stateOf([
			["The ", null],
			["fox", "modification"],
		]);
		assert.equal(textAfter(state, applyAccept(state)), "The fox");
	});

	test("accept clears every tracked mark", () => {
		const state = stateOf([
			["a", "insertion"],
			["b", "deletion"],
			["c", "modification"],
		]);
		const tr = applyAccept(state);
		assert.ok(tr);
		const ranges = collectTrackedRanges(tr.doc);
		assert.equal(ranges.insertion.length, 0);
		assert.equal(ranges.deletion.length, 0);
		assert.equal(ranges.modification.length, 0);
	});

	test("MULTI-RANGE: two deletions are both removed, not just the last", () => {
		// Ordering trap: removing the first range shifts the second out from under
		// its recorded positions, so a forward pass deletes the wrong words.
		const state = stateOf([
			["keep ", null],
			["DROP-ONE", "deletion"],
			[" middle ", null],
			["DROP-TWO", "deletion"],
			[" end", null],
		]);
		assert.equal(textAfter(state, applyAccept(state)), "keep  middle  end");
	});

	test("nothing tracked yields no transaction", () => {
		const state = stateOf([["plain text", null]]);
		assert.equal(applyAccept(state), null);
	});
});

describe("rejecting tracked changes", () => {
	test("an insertion is removed", () => {
		const state = stateOf([
			["The fox", null],
			[" jumps", "insertion"],
		]);
		assert.equal(textAfter(state, applyReject(state)), "The fox");
	});

	test("a deletion is restored — the text was never actually gone", () => {
		// This is why deletion is a mark rather than a removal: rejecting must be
		// able to bring the words back, and only marks can do that.
		const state = stateOf([
			["The quick", null],
			[" brown", "deletion"],
			[" fox", null],
		]);
		assert.equal(textAfter(state, applyReject(state)), "The quick brown fox");
	});

	test("a replacement reverts to the original text", () => {
		const state = stateOf([
			["The ", null],
			["quick", "deletion"],
			["fast", "insertion"],
			[" fox", null],
		]);
		assert.equal(textAfter(state, applyReject(state)), "The quick fox");
	});

	test("MULTI-RANGE: two insertions are both removed", () => {
		const state = stateOf([
			["keep ", null],
			["ADD-ONE", "insertion"],
			[" middle ", null],
			["ADD-TWO", "insertion"],
			[" end", null],
		]);
		assert.equal(textAfter(state, applyReject(state)), "keep  middle  end");
	});

	test("nothing tracked yields no transaction", () => {
		const state = stateOf([["plain text", null]]);
		assert.equal(applyReject(state), null);
	});
});

describe("accept and reject are inverses on a mixed document", () => {
	test("accept then the same doc rejected gives different text", () => {
		const runs: [string, string | null][] = [
			["The ", null],
			["quick", "deletion"],
			["fast", "insertion"],
			[" fox jumped", null],
			[" lazily", "insertion"],
		];
		const accepted = textAfter(stateOf(runs), applyAccept(stateOf(runs)));
		const rejected = textAfter(stateOf(runs), applyReject(stateOf(runs)));

		assert.equal(accepted, "The fast fox jumped lazily");
		assert.equal(rejected, "The quick fox jumped");
		assert.notEqual(accepted, rejected, "the two decisions must actually differ");
	});
});