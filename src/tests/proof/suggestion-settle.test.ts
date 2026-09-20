/**
 * A margin card's Approve/Reject must actually settle its mark.
 *
 * These are executable tests against the real editor schema and the real vendored
 * commands, because the defect they pin was invisible to source-level assertions. The
 * margin enumerated a mark's id with `String(...)`, while the library GENERATES numeric
 * ids and its commands compare with strict equality:
 *
 *     mark.attrs["id"] === suggestionId      // commands.js
 *
 * So every button was a silent no-op for a suggestion typed in the current session: the
 * command matched nothing, dispatched no transaction, and the card stayed on screen. The
 * same card appeared to work after a reload only because a different id type happened to
 * be in play. A feature that fails on one path and works on another is worse than one
 * that fails outright, which is why this is pinned at the command level.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { editorExtensions } from "@/components/editor/extensions";
import { applySuggestion, revertSuggestion } from "@/vendor/prosemirror-suggest-changes/commands.js";

const schema = getSchema(editorExtensions);

/** A paragraph holding one deletion mark with `id`, plus the mark's range. */
function docWithDeletion(id: number | string) {
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("a "),
			schema.text("word", [schema.marks.deletion.create({ id })]),
			schema.text(" z"),
		]),
	]);
	let from = -1;
	let to = -1;
	doc.descendants((node, pos) => {
		if (node.isText && node.marks.some((mark) => mark.type.name === "deletion")) {
			from = pos;
			to = pos + node.nodeSize;
		}
		return true;
	});
	assert.notEqual(from, -1, "fixture must contain a deletion mark");
	return { doc, from, to };
}

/** What the editor's enumeration reads off the mark: the id, with its type intact. */
function collectedId(doc: ReturnType<typeof docWithDeletion>["doc"], from: number): unknown {
	return doc.nodeAt(from)?.marks[0]?.attrs.id;
}

describe("approving a suggestion settles exactly its own mark", () => {
	test("a numeric id settles, which is what the library generates", () => {
		const { doc, from, to } = docWithDeletion(1);
		const id = collectedId(doc, from);
		assert.equal(typeof id, "number", "the library's own allocator returns numbers");

		const state = EditorState.create({ schema, doc });
		let dispatched = false;
		const applied = applySuggestion(id as number, from, to)(state, () => {
			dispatched = true;
		});
		assert.equal(applied, true, "Approving must apply");
		assert.equal(dispatched, true, "and must dispatch, or the card never updates");
	});

	test("CONTROL: a stringified id is a silent no-op", () => {
		// This is the exact bug, kept as a control so the assertion above is known to be
		// load-bearing rather than incidentally true.
		const { doc, from, to } = docWithDeletion(1);
		const state = EditorState.create({ schema, doc });
		const applied = applySuggestion(String(1), from, to)(state, () => {});
		assert.equal(applied, false, "the vendored command compares with ===, so this fails");
	});

	test("the type survives the save/reload round-trip", () => {
		// A mark reloaded from disk parses its id with JSON.parse, so a numeric id comes
		// back numeric. This is why preserving the type works on both paths instead of
		// fixing one and breaking the other.
		const { doc, from } = docWithDeletion(7);
		assert.equal(collectedId(doc, from), 7);
		assert.equal(typeof collectedId(doc, from), "number");
	});

	test("a legacy string id still settles, so old documents keep working", () => {
		// Documents written before the id scheme changed carry ids like "s3e34". The
		// comparison is strict but type-preserving, so a string id settles with a string.
		const { doc, from, to } = docWithDeletion("s3e34");
		const id = collectedId(doc, from);
		assert.equal(id, "s3e34");
		const state = EditorState.create({ schema, doc });
		assert.equal(applySuggestion(id as string, from, to)(state, () => {}), true);
	});
});

describe("rejecting a suggestion settles exactly its own mark", () => {
	test("a numeric id reverts the mark and keeps the text", () => {
		// Reject has to bring the deleted words BACK, which is the whole reason a removal
		// is a mark rather than a delete.
		const { doc, from, to } = docWithDeletion(3);
		const id = collectedId(doc, from);
		const state = EditorState.create({ schema, doc });
		let dispatched = false;
		const applied = revertSuggestion(id as number, from, to)(state, () => {
			dispatched = true;
		});
		assert.equal(applied, true, "Rejecting must revert");
		assert.equal(dispatched, true, "and must dispatch");
	});

	test("CONTROL: a stringified numeric id does not revert", () => {
		const { doc, from, to } = docWithDeletion(3);
		const state = EditorState.create({ schema, doc });
		assert.equal(revertSuggestion(String(3), from, to)(state, () => {}), false);
	});
});