/**
 * Settling a MODIFICATION suggestion, which the vendored command could not do.
 *
 * `insertion` and `deletion` marks are the common case, but the editor also produces
 * `modification` marks, and three separate defects made those un-settleable. All three
 * were found by adversarial review against the real schema and the real vendored code,
 * and all three are exercised here because none is visible to a source-level assertion:
 *
 *   1. `revertSuggestion` returned early on `!tr.steps.length`, which is always true for
 *      a modification-only suggestion, so Reject dispatched nothing at all.
 *   2. Both commands passed `undefined` as the id to modification handling, so approving
 *      one card applied every modification inside the computed range - including marks
 *      belonging to other suggestions.
 *   3. `removeNodeMark` was used to drop a mark from TEXT, where ProseMirror throws
 *      `NodeType.create can't construct text nodes`, killing the whole command.
 *
 * These run against `editorExtensions`, so the mark schema is the app's, not a fixture.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSchema } from "@tiptap/core";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { editorExtensions } from "@/components/editor/extensions";
import { applySuggestion, revertSuggestion } from "@/vendor/prosemirror-suggest-changes/commands.js";
import { transformToSuggestionTransaction } from "@/vendor/prosemirror-suggest-changes/index.js";

const schema = getSchema(editorExtensions);

function modification(id: number, type = "text", extra: Record<string, unknown> = {}) {
	return schema.marks.modification.create({
		id,
		type,
		previousValue: "old",
		newValue: "new",
		...extra,
	});
}

/** A paragraph of `text` carrying a modification mark with `id`. */
function docWithModification(id: number, type = "text", extra: Record<string, unknown> = {}) {
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [schema.text("WORD", [modification(id, type, extra)])]),
	]);
	let from = -1;
	let to = -1;
	doc.descendants((node, pos) => {
		if (node.isText && node.marks.some((mark) => mark.type.name === "modification")) {
			from = pos;
			to = pos + node.nodeSize;
		}
		return true;
	});
	assert.notEqual(from, -1, "fixture must contain a modification mark");
	return { doc, from, to };
}

describe("a modification suggestion can be approved and rejected", () => {
	test("Reject dispatches instead of silently doing nothing", () => {
		// Defect 1. A modification-only suggestion leaves insertion/deletion marks
		// untouched, so the old `if (!tr.steps.length) return false` fired before the
		// modification pass ever ran. The card stayed on screen, unresponsive.
		const { doc, from, to } = docWithModification(4);
		const state = EditorState.create({ schema, doc });
		let dispatched = false;
		const ok = revertSuggestion(4, from, to)(state, () => {
			dispatched = true;
		});
		assert.equal(ok, true, "Rejecting a modification must report success");
		assert.equal(dispatched, true, "and must dispatch, or the UI never updates");
	});

	test("Approve dispatches", () => {
		const { doc, from, to } = docWithModification(4);
		const state = EditorState.create({ schema, doc });
		assert.equal(applySuggestion(4, from, to)(state, () => {}), true);
	});

	test("neither command throws for a mark sitting on text", () => {
		// Defect 3. `removeNodeMark` is for NODE marks; a mark on text is inline and
		// made ProseMirror throw `NodeType.create can't construct text nodes`.
		const { doc, from, to } = docWithModification(4);
		const state = EditorState.create({ schema, doc });
		assert.doesNotThrow(() => applySuggestion(4, from, to)(state, () => {}));
		assert.doesNotThrow(() => revertSuggestion(4, from, to)(state, () => {}));
	});

	test("an `attr` modification on text is settled too, not fatal", () => {
		// An attr modification over text has no attribute to restore - text carries
		// none - so dropping the mark is the whole revert. It must not take the command
		// down with it.
		const { doc, from, to } = docWithModification(4, "attr", { attrName: "href" });
		const state = EditorState.create({ schema, doc });
		assert.doesNotThrow(() => revertSuggestion(4, from, to)(state, () => {}));
	});
});

describe("modification settlement is scoped to the card's own id", () => {
	test("rejecting one modification leaves another inside the same range alone", () => {
		// Defect 2, and the one that silently changed the wrong text. Both commands
		// passed `undefined` where the id belonged, so `modificationIsInSet` matched
		// EVERY modification in [from, to] rather than the requested one.
		const doc = schema.node("doc", null, [
			schema.node("paragraph", null, [
				schema.text("one", [modification(1)]),
				schema.text("two", [modification(2)]),
			]),
		]);
		const from = 1;
		const to = doc.content.size - 1;
		const state = EditorState.create({ schema, doc });

		// A holder, because TypeScript narrows a `let` assigned only inside a callback.
		const captured: { tr: Transaction | null } = { tr: null };
		const ok = revertSuggestion(1, from, to)(state, (transaction) => {
			captured.tr = transaction;
		});
		assert.equal(ok, true, "the target mark must settle");
		assert.ok(captured.tr, "a transaction must be dispatched");

		const remaining: unknown[] = [];
		captured.tr.doc.descendants((node) => {
			for (const mark of node.marks) {
				if (mark.type.name === "modification") remaining.push(mark.attrs.id);
			}
			return true;
		});
		assert.deepEqual(
			remaining,
			[2],
			"rejecting id 1 must leave id 2 pending, not settle it too",
		);
	});
});
describe("the position threading works for nested content", () => {
	// The fix had to pass an absolute position into the modification pass, because
	// `node.descendants` reports positions RELATIVE to the node it is called on - verified
	// directly: from the document a nested paragraph's text is at 3, from the list it is
	// at 2. Getting this wrong would mis-settle every modification that is not in a
	// top-level paragraph, which is most real documents.
	function nestedDoc(marks: { id: number; text: string }[]) {
		const doc = schema.node("doc", null, [
			schema.node("blockquote", null, [
				schema.node("bulletList", null, [
					schema.node("listItem", null, [
						schema.node("paragraph", null, marks.map((m) => schema.text(m.text, [modification(m.id)]))),
					]),
				]),
			]),
		]);
		return doc;
	}

	test("a modification deep in a list settles", () => {
		const doc = nestedDoc([{ id: 5, text: "nested" }]);
		let from = -1;
		let to = -1;
		doc.descendants((node, pos) => {
			if (node.isText) {
				from = pos;
				to = pos + node.nodeSize;
			}
			return true;
		});
		const state = EditorState.create({ schema, doc });
		assert.equal(revertSuggestion(5, from, to)(state, () => {}), true);
	});

	test("id scoping holds when the marks are nested, not adjacent at the top level", () => {
		// The document-wide range is used here, which is the path that relies on
		// `startPos` defaulting to 0 and the recursion adding each child's offset.
		const doc = nestedDoc([
			{ id: 10, text: "one" },
			{ id: 11, text: "two" },
		]);
		const from = 1;
		const to = doc.content.size - 1;
		const state = EditorState.create({ schema, doc });

		const captured: { tr: Transaction | null } = { tr: null };
		assert.equal(
			revertSuggestion(10, from, to)(state, (transaction) => {
				captured.tr = transaction;
			}),
			true,
		);
		assert.ok(captured.tr);

		const remaining: unknown[] = [];
		captured.tr.doc.descendants((node) => {
			for (const mark of node.marks) {
				if (mark.type.name === "modification") remaining.push(mark.attrs.id);
			}
			return true;
		});
		assert.deepEqual(remaining, [11], "the deep-nested neighbour must stay pending");
	});
});

describe("a node attribute change does not crash Suggesting mode", () => {
	// Found by adversarial review, and reachable from the UI: `paragraph` has a settable
	// `textAlign`, so the toolbar's Align buttons dispatch an AttrStep through
	// `withSuggestChanges`. The library then attached a modification mark to the
	// PARAGRAPH, which the mark schema does not allow on block nodes, and
	// `setNodeMarkup` threw `RangeError: Invalid content for node doc` - the editor
	// died before anything could be reviewed.
	test("setting an attribute on a block node does not throw", () => {
		const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello")])]);
		const state = EditorState.create({ schema, doc });
		const tr = state.tr.setNodeAttribute(0, "textAlign", "center");

		assert.doesNotThrow(
			() => transformToSuggestionTransaction(tr, state, () => 99),
			"a formatting change must not take the editor down",
		);
	});

	test("the attribute change still lands", () => {
		// The mark cannot be represented, but the change must not be silently dropped
		// either - the user clicked the button.
		const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello")])]);
		const state = EditorState.create({ schema, doc });
		const out = transformToSuggestionTransaction(
			state.tr.setNodeAttribute(0, "textAlign", "center"),
			state,
			() => 99,
		);
		assert.equal(out.doc.child(0).attrs.textAlign, "center");
	});
});
