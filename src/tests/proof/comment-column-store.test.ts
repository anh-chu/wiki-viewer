/**
 * The comment column's shared visibility state.
 *
 * The top bar owns the control and the editor owns the document, so this store is the
 * one place both can see. Two fields with different writers, which is the part worth
 * testing:
 *
 *   - `count` is published by the EDITOR (only it can see the comments);
 *   - `collapsed` is the reader's CHOICE, written only by the top bar.
 *
 * Keeping them separate is what lets a reader's collapse survive a document that
 * happens to have no comments, while a document that GAINS one still shows its column.
 * A single "visible" boolean could not express both.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { useCommentColumnStore } from "@/stores/comment-column-store";

beforeEach(() => {
	useCommentColumnStore.setState({ count: 0, collapsed: false });
});

describe("the comment column's visibility", () => {
	test("the count comes from the editor and starts at zero", () => {
		assert.equal(useCommentColumnStore.getState().count, 0);
		useCommentColumnStore.getState().setCount(3);
		assert.equal(useCommentColumnStore.getState().count, 3);
	});

	test("the toggle flips only the reader's choice", () => {
		useCommentColumnStore.getState().setCount(2);
		useCommentColumnStore.getState().toggle();
		const state = useCommentColumnStore.getState();
		assert.equal(state.collapsed, true);
		assert.equal(state.count, 2, "toggling must not disturb the count");
		useCommentColumnStore.getState().toggle();
		assert.equal(useCommentColumnStore.getState().collapsed, false);
	});

	test("a collapse survives a document change that clears the count", () => {
		// The reader collapsed the column deliberately. Unmounting the editor clears the
		// count; it must not also be read as re-showing the column.
		useCommentColumnStore.getState().setCount(2);
		useCommentColumnStore.getState().toggle();
		useCommentColumnStore.getState().setCount(0);
		assert.equal(
			useCommentColumnStore.getState().collapsed,
			true,
			"the choice outlives the document that prompted it",
		);
	});

	test("expand re-shows the column, for jumping to a comment from the panel", () => {
		useCommentColumnStore.getState().toggle();
		assert.equal(useCommentColumnStore.getState().collapsed, true);
		useCommentColumnStore.getState().expand();
		assert.equal(useCommentColumnStore.getState().collapsed, false);
	});

	test("expand is idempotent, so it cannot toggle the column shut", () => {
		// Unlike `toggle`, calling this twice must not flip back. A jump-to-comment that
		// hid the very card it was jumping to would be worse than doing nothing.
		useCommentColumnStore.getState().expand();
		useCommentColumnStore.getState().expand();
		assert.equal(useCommentColumnStore.getState().collapsed, false);
	});
});