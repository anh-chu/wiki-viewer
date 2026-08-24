import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "@tiptap/pm/model";
import { mapSuggestionDecorations } from "../../lib/proof/suggestion-decorator.js";
import type { Block, Suggestion } from "../../lib/proof/types.js";

const schema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph: { content: "inline*", group: "block" },
		text: { group: "inline" },
	},
});

const doc = schema.node("doc", null, [
	schema.node("paragraph", null, schema.text("Current text")),
]);
const blocks: Block[] = [{ ref: "b000001", type: "paragraph", markdown: "Current text" }];

function suggestion(kind: Suggestion["kind"], id = `s-${kind}`): Suggestion {
	return {
		id,
		ref: "b000001",
		kind,
		status: "pending",
		by: "ai:test",
		markdown: kind === "delete" ? undefined : "Proposed text",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

test("maps replace and delete to block wash plus review badge", () => {
	const descriptors = mapSuggestionDecorations(
		[suggestion("replace"), suggestion("delete")],
		doc,
		blocks,
	);
	assert.deepEqual(
		descriptors.map(({ role, type, kind }) => ({ role, type, kind })),
		[
			{ role: "block", type: "node", kind: "replace" },
			{ role: "badge", type: "widget", kind: "replace" },
			{ role: "block", type: "node", kind: "delete" },
			{ role: "badge", type: "widget", kind: "delete" },
		],
	);
	const blocksOnly = descriptors.filter((descriptor) => descriptor.role === "block");
	assert.match(blocksOnly[0].className, /bg-success-soft/);
	assert.match(blocksOnly[1].className, /line-through/);
});

test("maps inserts to explicit-side ghost and review badge widgets", () => {
	const descriptors = mapSuggestionDecorations(
		[suggestion("insertBefore"), suggestion("insertAfter")],
		doc,
		blocks,
	);
	assert.deepEqual(
		descriptors.map((descriptor) => ({
			role: descriptor.role,
			type: descriptor.type,
			side: descriptor.type === "widget" ? descriptor.side : undefined,
			kind: descriptor.kind,
		})), 
		[
			{ role: "ghost", type: "widget", side: -1, kind: "insertBefore" },
			{ role: "badge", type: "widget", side: -1, kind: "insertBefore" },
			{ role: "ghost", type: "widget", side: 1, kind: "insertAfter" },
			{ role: "badge", type: "widget", side: 1, kind: "insertAfter" },
		],
	);
});

test("drops stale and missing block refs", () => {
	const stale = { ...suggestion("replace", "stale"), stale: true };
	const missing = { ...suggestion("delete", "missing"), ref: "b999999" };
	assert.deepEqual(mapSuggestionDecorations([stale, missing], doc, blocks), []);
});
