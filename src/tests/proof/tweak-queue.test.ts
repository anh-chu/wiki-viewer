import assert from "node:assert/strict";
import { test } from "node:test";

import {
	clearTweakItems,
	removeTweakItem,
	TWEAK_DISPATCH_LABELS,
	upsertTweakItem,
} from "../../components/editor/tweak/tweak-queue.js";
import type { TweakItem } from "../../components/editor/tweak/tweak-types.js";

function item(overrides: Partial<TweakItem> = {}): TweakItem {
	return {
		itemId: "item-1",
		targetKey: "block-1",
		displaySnippet: "Original block",
		instruction: "Make it clearer",
		...overrides,
	};
}

test("Tweak queue updates an existing target without inflating its count", () => {
	const queued = [item()];
	const result = upsertTweakItem(
		queued,
		{
			targetKey: "block-1",
			displaySnippet: "Updated block",
			instruction: "Make it shorter",
		},
		() => "new-item",
	);

	assert.equal(result.itemId, "item-1");
	assert.equal(result.items.length, 1);
	assert.deepEqual(result.items[0], item({
		displaySnippet: "Updated block",
		instruction: "Make it shorter",
	}));
});

test("Tweak dispatch labels distinguish markdown Rewrite from HTML Apply", () => {
	assert.equal(TWEAK_DISPATCH_LABELS.markdown, "Rewrite");
	assert.equal(TWEAK_DISPATCH_LABELS.html, "Apply");
});

test("Tweak queue removes one selection and clears all selections", () => {
	const queued = [item(), item({ itemId: "item-2", targetKey: "block-2" })];
	const afterRemove = removeTweakItem(queued, "item-1");

	assert.deepEqual(afterRemove, [item({ itemId: "item-2", targetKey: "block-2" })]);
	assert.deepEqual(clearTweakItems(), []);
});
