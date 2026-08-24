import { test } from "node:test";
import assert from "node:assert/strict";
import {
	captureSuggestionBatch,
	decideSuggestionCaptures,
	type SuggestionCaptureBlock,
} from "../../components/editor/hooks/use-suggestion-capture.js";

test("suggesting capture decides replace, delete, and insertAfter operations", async () => {
	const snapshotBlocks: SuggestionCaptureBlock[] = [
		{ ref: "replace-ref", markdown: "Original" },
		{ ref: "delete-ref", markdown: "Removed" },
	];
	const decisions = decideSuggestionCaptures(
		["Updated", null, "Appended"],
		snapshotBlocks,
	);
	assert.deepEqual(
		decisions,
		[
			{ ref: "replace-ref", kind: "replace", markdown: "Updated" },
			{ ref: "delete-ref", kind: "delete" },
			{ ref: "delete-ref", kind: "insertAfter", markdown: "Appended" },
		],
	);

	const posted: string[] = [];
	const result = await captureSuggestionBatch({
		path: "notes.md",
		decisions,
		getRevision: () => 7,
		refresh: async () => {},
		capture: async (op) => {
			posted.push(`${op.kind}:${op.ref}`);
			return true;
		},
	});
	assert.deepEqual(posted, [
		"replace:replace-ref",
		"delete:delete-ref",
		"insertAfter:delete-ref",
	]);
	assert.equal(result.shouldRevert, true);
});

test("failed suggesting post keeps live text and exposes failed operations for retry", async () => {
	const decisions = decideSuggestionCaptures(
		["Typed while offline"],
		[{ ref: "paragraph", markdown: "Original" }],
	);
	const result = await captureSuggestionBatch({
		path: "notes.md",
		decisions,
		getRevision: () => 7,
		refresh: async () => {},
		capture: async () => false,
	});

	assert.equal(result.shouldRevert, false, "failed post must not trigger snapshot restore");
	assert.deepEqual(result.failed, decisions, "failed operations remain available for Retry");
});
