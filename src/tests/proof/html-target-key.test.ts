import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveHtmlTargetKey } from "../../components/editor/tweak/html-target-key.js";
import { upsertTweakItem } from "../../components/editor/tweak/tweak-queue.js";

function pick(overrides: Partial<{ id: string; selector: string; elementPath: string }> = {}) {
	return {
		id: "p1",
		selector: "#reused-id",
		elementPath: "html[1]/body[2]/main[1]/section[1]/p[1]",
		...overrides,
	};
}

function upsertPick(items: Parameters<typeof upsertTweakItem>[0], selected: ReturnType<typeof pick>) {
	return upsertTweakItem(
		items,
		{
			targetKey: deriveHtmlTargetKey(selected),
			displaySnippet: selected.selector,
			instruction: `Edit ${selected.id}`,
		},
		() => "queued-item",
	);
}

test("HTML target key dedupes repeated picker selections", () => {
	const first = upsertPick([], pick({ id: "p1" }));
	const repeated = upsertPick(first.items, pick({ id: "p2" }));

	assert.equal(repeated.items.length, 1);
	assert.equal(repeated.itemId, first.itemId);
});

test("HTML target key keeps selector-colliding picker elements separate", () => {
	const first = upsertPick([], pick({ id: "p1" }));
	const distinct = upsertPick(
		first.items,
		pick({ id: "p2", elementPath: "html[1]/body[2]/main[1]/section[2]/p[1]" }),
	);

	assert.equal(distinct.items.length, 2);
	assert.notEqual(distinct.items[0].targetKey, distinct.items[1].targetKey);
});

test("HTML target key keeps different picker selectors separate", () => {
	const first = upsertPick([], pick({ id: "p1" }));
	const distinct = upsertPick(
		first.items,
		pick({
			id: "p2",
			selector: "#other-id",
			elementPath: "html[1]/body[2]/main[1]/section[1]/p[2]",
		}),
	);

	assert.equal(distinct.items.length, 2);
	assert.notEqual(distinct.items[0].targetKey, distinct.items[1].targetKey);
});
