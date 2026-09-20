/**
 * The annotations panel's filter and count logic.
 *
 * This is the surface that reviews suggestions, so the two ways it can fail are
 * both review failures rather than cosmetic ones:
 *
 *   - the trigger badge counts something the list does not contain, so a reader
 *     is told there are three items and shown one;
 *   - a filter hides an item that is present, so a suggestion that still needs a
 *     decision is invisible while its count claims it exists.
 *
 * `panelView` is the single definition of both, which is why it is pure and lives
 * outside the component: a component-only version could disagree with its own badge.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { panelView } from "@/components/editor/annotations-panel";

function thread(blockRef: string) {
	return { blockRef, comments: [] as never[] };
}

function suggestion(id: number, kind: "insert" | "remove" = "insert") {
	return { id, kind, from: 1, to: 5, text: "word" } as const;
}

describe("the panel lists what it counts", () => {
	test("the total is comments plus suggestions", () => {
		const view = panelView("all", [thread("a"), thread("b")], [suggestion(1)]);
		assert.equal(view.total, 3, "the badge must count every item in the list");
		assert.equal(view.comments.length, 2);
		assert.equal(view.suggestions.length, 1);
	});

	test("a suggestion ALONE is still shown", () => {
		// The regression this guards: keying the only review surface on comments means a
		// document whose sole annotation is a suggestion offers no way to settle it.
		const view = panelView("all", [], [suggestion(7)]);
		assert.equal(view.total, 1);
		assert.equal(view.suggestions.length, 1);
		assert.equal(view.empty, false, "one suggestion is not an empty panel");
	});

	test("a comment ALONE is still shown", () => {
		const view = panelView("all", [thread("a")], []);
		assert.equal(view.total, 1);
		assert.equal(view.comments.length, 1);
		assert.equal(view.empty, false);
	});
});

describe("each filter shows its own kind", () => {
	test("the comments filter hides suggestions but keeps its own", () => {
		const view = panelView("comments", [thread("a")], [suggestion(1)]);
		assert.equal(view.comments.length, 1);
		assert.equal(view.suggestions.length, 0, "the comments filter must exclude changes");
		// The badge keeps counting BOTH: it describes the document, not the filter, so a
		// filtered-out suggestion is still outstanding work.
		assert.equal(view.total, 2);
	});

	test("the suggestions filter hides comments but keeps its own", () => {
		const view = panelView("suggestions", [thread("a")], [suggestion(1)]);
		assert.equal(view.suggestions.length, 1);
		assert.equal(view.comments.length, 0, "the changes filter must exclude comments");
		assert.equal(view.total, 2);
	});

	test("a filter with nothing behind it reports empty, not merely unused", () => {
		// Distinguishing these is what lets the body say "No suggested changes" instead of
		// showing a blank box the reader has to interpret.
		const view = panelView("suggestions", [thread("a")], []);
		assert.equal(view.empty, true);
		assert.equal(view.total, 1, "the document still has a comment");
	});

	test("nothing at all is empty on every filter", () => {
		for (const filter of ["all", "comments", "suggestions"] as const) {
			assert.equal(panelView(filter, [], []).empty, true, `${filter} with no items`);
			assert.equal(panelView(filter, [], []).total, 0);
		}
	});
});