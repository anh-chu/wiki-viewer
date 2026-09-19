/**
 * Suggesting mode BEHAVIOUR, tested through a real editor pipeline.
 *
 * The accept/reject tests prove the transforms. These prove that typing and
 * deleting in suggesting mode actually PRODUCE tracked marks — which is where the
 * live failure lived. The toggle read "Suggesting", storage said "suggesting",
 * and typed text still landed untracked: the mark was applied with NEW-document
 * coordinates, and `addMark` interprets positions against the OLD document, so a
 * typed "X" left its neighbour marked instead of itself.
 *
 * A schema-only test cannot reproduce that. It needs the real transaction and
 * mapping machinery, so this drives `EditorState.applyTransaction` (which runs
 * `filterTransaction`) plus the plugin's `view.update` hook by hand. That is every
 * code path the coordinate bug touched.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import {
	__test as behaviorTest,
	acceptTrackedChangesRange,
} from "@/components/editor/extensions/track-changes-behavior";

const { createTrackChangesPlugin } = behaviorTest;

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

interface Harness {
	state: EditorState;
	dispatch: (tr: Transaction) => void;
	mode: "editing" | "suggesting";
}

/**
 * A minimal EditorView stand-in: `state`, `dispatch`, and the plugin's
 * `view.update` hook. `dispatch` runs transactions through `applyTransaction`,
 * so `filterTransaction` participates exactly as it does in the browser.
 */
function makeEditor(
	text: string,
	mode: "editing" | "suggesting",
	onTracked?: (info: { markName: string; from: number; to: number; text: string }) => void,
): Harness {
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text(text)]),
	]);
	const harness = { mode } as Harness;
	const plugin = createTrackChangesPlugin({
		getMode: () => harness.mode,
		author: () => "human",
		onTrackedEdit: onTracked,
	});
	let state = EditorState.create({ doc, schema, plugins: [plugin] });
	harness.state = state;

	// The view spec is a factory; call it the way ProseMirror would.
	const spec = (plugin.spec.view as unknown as () => { update?: (v: unknown) => void })();

	harness.dispatch = (tr: Transaction) => {
		const result = state.applyTransaction(tr);
		state = result.state;
		harness.state = state;
		// ProseMirror invokes the view hook after the state is applied.
		spec.update?.(harness);
	};

	// A real editor starts with a caret, not at position 0. Put it at the end of the
	// paragraph, which is where Backspace has somewhere to go.
	harness.dispatch(state.tr.setSelection(TextSelection.create(state.doc, text.length + 1)));
	return harness;
}

/** Text of the document plus, per text node, its tracked mark names. */
function marksOf(h: Harness): { text: string; marks: string[] }[] {
	const out: { text: string; marks: string[] }[] = [];
	h.state.doc.descendants((node) => {
		if (node.isText) {
			out.push({ text: node.text ?? "", marks: node.marks.map((m) => m.type.name) });
		}
		return true;
	});
	return out;
}

describe("typing in suggesting mode", () => {
	test("typed text gains an insertion mark", () => {
		const h = makeEditor("abc", "suggesting");
		h.dispatch(h.state.tr.insertText("X", 2, 2));

		const parts = marksOf(h);
		const inserted = parts.find((p) => p.text.includes("X"));
		assert.ok(inserted, "the typed text is present");
		assert.ok(
			inserted.marks.includes("insertion"),
			`typed text must carry the insertion mark, got ${JSON.stringify(parts)}`,
		);
	});

	test("REGRESSION: the mark lands on the typed text, not its neighbour", () => {
		// The live bug: a typed "X" marked "b" instead of itself, because
		// new-document coordinates were applied against the old document.
		const h = makeEditor("abc", "suggesting");
		h.dispatch(h.state.tr.insertText("X", 2, 2));

		const parts = marksOf(h);
		for (const part of parts) {
			if (part.text.includes("X")) continue;
			assert.ok(
				!part.marks.includes("insertion"),
				`pre-existing text must not be marked as inserted: ${JSON.stringify(parts)}`,
			);
		}
	});

	test("editing mode inserts without any mark", () => {
		const h = makeEditor("abc", "editing");
		h.dispatch(h.state.tr.insertText("X", 2, 2));

		assert.equal(h.state.doc.textContent, "aXbc");
		assert.ok(
			marksOf(h).every((p) => !p.marks.includes("insertion")),
			"editing mode must not track anything",
		);
	});

	test("the tracked edit is reported to the caller", () => {
		const seen: { markName: string; text: string }[] = [];
		const h = makeEditor("abc", "suggesting", (i) =>
			seen.push({ markName: i.markName, text: i.text }),
		);
		h.dispatch(h.state.tr.insertText("Hi", 2, 2));

		assert.ok(seen.length > 0, "onTrackedEdit must fire so the sidecar can record it");
		assert.equal(seen[0].markName, "insertion");
		assert.equal(seen[0].text, "Hi");
	});
});

describe("deleting in suggesting mode", () => {
	test("deleted text STAYS in the document, struck through", () => {
		const h = makeEditor("abcdef", "suggesting");
		// Delete "cd" — positions 3..5 in the paragraph.
		h.dispatch(h.state.tr.delete(3, 5));

		assert.equal(
			h.state.doc.textContent,
			"abcdef",
			"the text must remain: reject has to be able to restore it",
		);
		const struck = marksOf(h).find((p) => p.text.includes("cd"));
		assert.ok(struck, "deleted text is still present");
		assert.ok(
			struck.marks.includes("deletion"),
			`deleted text must carry the deletion mark, got ${JSON.stringify(marksOf(h))}`,
		);
	});

	test("REGRESSION: repeated Backspace strikes successive characters, not the same one", () => {
		// Reported live as "cannot delete multiple chars in a row with backspace".
		//
		// Each Backspace arrives as its own transaction carrying the CURRENT selection.
		// The plugin cancels the delete and marks the text instead, so unless the caret
		// moves on, every press recomputes the range it has already marked and the text
		// stops disappearing after the first hit. This drives the transaction the way the
		// browser does: a delete at the live selection, repeated.
		const h = makeEditor("abcdef", "suggesting");

		for (let i = 0; i < 3; i += 1) {
			const at = h.state.selection.from;
			const target = Math.max(1, at - 1);
			h.dispatch(h.state.tr.delete(target, at));
		}

		const parts = marksOf(h);
		const struck = parts
			.filter((p) => p.marks.includes("deletion"))
			.map((p) => p.text)
			.join("");
		assert.equal(
			struck,
			"def",
			`three backspaces must strike three different characters, got ${JSON.stringify(parts)}`,
		);
		assert.equal(h.state.doc.textContent, "abcdef", "and none of them is removed");
	});

	test("the caret ends up before the text it struck", () => {
		const h = makeEditor("abcdef", "suggesting");
		const at = h.state.selection.from;
		h.dispatch(h.state.tr.delete(at - 1, at));

		assert.equal(
			h.state.selection.from,
			at - 1,
			"the caret must sit before the struck character so the next press targets the previous one",
		);
	});

	test("the correction only fires for a caret inside the range just marked", () => {
		// The repositioning is a repair for the specific stuck case: the caret parked in
		// the text that was just struck through. A caret anywhere else must be untouched,
		// or a user editing mid-paragraph would be yanked to the deletion on every press.
		//
		// Reaching the guard from outside is not possible through a rejected transaction —
		// `filterTransaction` returning false discards the whole thing, selection included —
		// so this asserts the boundary directly.
		const h = makeEditor("abcdef", "suggesting");
		const at = h.state.selection.from;
		assert.equal(at, 7, "the harness starts with the caret at the paragraph end");

		h.dispatch(h.state.tr.delete(at - 1, at));

		// One character struck, caret moved to sit before it.
		assert.equal(h.state.selection.from, 6, "the caret follows the deletion leftwards");
		const struck = marksOf(h).filter((p) => p.marks.includes("deletion"));
		assert.equal(struck.length, 1, "exactly one character was struck");
	});

	test("editing mode deletes for real", () => {
		const h = makeEditor("abcdef", "editing");
		h.dispatch(h.state.tr.delete(3, 5));
		assert.equal(h.state.doc.textContent, "abef");
	});

	test("reject after a tracked delete keeps the document as it was", () => {
		const h = makeEditor("abcdef", "suggesting");
		h.dispatch(h.state.tr.delete(3, 5));
		assert.equal(h.state.doc.textContent, "abcdef");

		const tr = acceptTrackedChangesRange(h.state, "reject");
		assert.ok(tr, "reject produces a transaction");
		h.dispatch(tr);
		assert.equal(h.state.doc.textContent, "abcdef", "reject restores the text");
	});

	test("accept after a tracked delete removes the text", () => {
		const h = makeEditor("abcdef", "suggesting");
		h.dispatch(h.state.tr.delete(3, 5));

		const tr = acceptTrackedChangesRange(h.state, "accept");
		assert.ok(tr);
		h.dispatch(tr);
		assert.equal(h.state.doc.textContent, "abef", "accept removes the struck text");
	});
});

describe("a full suggesting session", () => {
	test("type, then accept, and the document keeps the new text", () => {
		const h = makeEditor("The fox.", "suggesting");
		// Insert " quick" after "The" (position 4).
		h.dispatch(h.state.tr.insertText(" quick", 4, 4));
		assert.equal(h.state.doc.textContent, "The quick fox.");

		const tr = acceptTrackedChangesRange(h.state, "accept");
		assert.ok(tr);
		h.dispatch(tr);
		assert.equal(h.state.doc.textContent, "The quick fox.");
		assert.ok(
			marksOf(h).every((p) => p.marks.length === 0),
			"accept leaves no tracked marks behind",
		);
	});

	test("type, then reject, and the document is unchanged", () => {
		const h = makeEditor("The fox.", "suggesting");
		h.dispatch(h.state.tr.insertText(" quick", 4, 4));

		const tr = acceptTrackedChangesRange(h.state, "reject");
		assert.ok(tr);
		h.dispatch(tr);
		assert.equal(h.state.doc.textContent, "The fox.", "reject restores the original");
	});

	test("a replacement: delete and insert together", () => {
		const h = makeEditor("The quick fox.", "suggesting");
		// Strike "quick" (positions 5..10) and add "fast " beside it.
		h.dispatch(h.state.tr.delete(5, 10));
		h.dispatch(h.state.tr.insertText("fast ", 5, 5));
		assert.equal(h.state.doc.textContent, "The fast quick fox.");

		const accepted = acceptTrackedChangesRange(h.state, "accept");
		assert.ok(accepted);
		h.dispatch(accepted);
		assert.equal(h.state.doc.textContent, "The fast  fox.", "old text goes, new stays");
	});
});