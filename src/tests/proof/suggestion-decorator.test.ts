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
		mention: { inline: true, group: "inline", atom: true },
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

test("maps replace to inline redline and delete to struck block", () => {
	const descriptors = mapSuggestionDecorations(
		[suggestion("replace"), suggestion("delete")],
		doc,
		blocks,
	);
	assert.deepEqual(
		descriptors.map(({ role, type, kind }) => ({ role, type, kind })),
		[
			{ role: "block", type: "node", kind: "replace" },
			{ role: "inline-delete", type: "inline", kind: "replace" },
			{ role: "insert", type: "widget", kind: "replace" },
			{ role: "badge", type: "widget", kind: "replace" },
			{ role: "block", type: "node", kind: "delete" },
			{ role: "badge", type: "widget", kind: "delete" },
		],
	);
	const replaceMarker = descriptors.find(
		(descriptor) => descriptor.type === "node" && descriptor.kind === "replace",
	);
	if (!replaceMarker || replaceMarker.type !== "node") throw new Error("missing replace marker");
	assert.doesNotMatch(replaceMarker.className, /bg-/);
	const inlineDelete = descriptors.find((descriptor) => descriptor.type === "inline");
	if (!inlineDelete || inlineDelete.type !== "inline") throw new Error("missing inline deletion");
	assert.deepEqual(
		{ from: inlineDelete.from, to: inlineDelete.to },
		{ from: 1, to: 8 },
	);
	const insert = descriptors.find(
		(descriptor) => descriptor.type === "widget" && descriptor.role === "insert",
	);
	if (!insert || insert.type !== "widget") throw new Error("missing inline insertion");
	assert.deepEqual(
		{ from: insert.from, side: insert.side, text: insert.text },
		{ from: 8, side: 1, text: "Proposed" },
	);
	const deleteMarker = descriptors.find(
		(descriptor) => descriptor.type === "node" && descriptor.kind === "delete",
	);
	if (!deleteMarker || deleteMarker.type !== "node") throw new Error("missing delete marker");
	assert.match(deleteMarker.className, /line-through/);
	assert.doesNotMatch(deleteMarker.className, /bg-/);
});

test("falls back to border-only marker for inline atoms", () => {
	const atomDoc = schema.node("doc", null, [
		schema.node("paragraph", null, [schema.node("mention"), schema.text("Current text")]),
	]);
	const descriptors = mapSuggestionDecorations([suggestion("replace")], atomDoc, blocks);
	assert.deepEqual(
		descriptors.map(({ role, type }) => ({ role, type })),
		[
			{ role: "block", type: "node" },
			{ role: "badge", type: "widget" },
		],
	);
	const marker = descriptors.find((descriptor) => descriptor.type === "node");
	assert.ok(marker);
	assert.doesNotMatch(marker.className, /bg-/);
});

test("counts overlapping suggestions on same block badge", () => {
	const descriptors = mapSuggestionDecorations(
		[suggestion("replace", "s-one"), suggestion("replace", "s-two")],
		doc,
		blocks,
	);
	assert.equal(descriptors.filter((descriptor) => descriptor.role === "badge").length, 2);
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
