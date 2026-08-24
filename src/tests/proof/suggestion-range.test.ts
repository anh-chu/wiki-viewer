import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeSuggestionRange } from "../../lib/proof/suggestion-range.js";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { readSidecar } from "../../lib/proof/sidecar.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-suggestion-range-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

test("trims common prefix and suffix to one tight range", () => {
	assert.deepEqual(
		computeSuggestionRange("The quick brown fox", "The quick red fox"),
		{ start: 10, end: 15 },
	);
	assert.deepEqual(
		computeSuggestionRange("The quick brown fox", "The quick red brown fox"),
		{ start: 10, end: 10 },
	);
});

test("identical blocks produce no range", () => {
	assert.equal(computeSuggestionRange("Same text", "Same text"), undefined);
});

test("multiple separated edits omit range", () => {
	assert.equal(
		computeSuggestionRange("one two three four", "one TWO three FOUR"),
		undefined,
	);
});

test("range round-trips through suggestion.add and archival", async () => {
	const mdPath = "range-round-trip.md";
	await writeFile(path.join(tmpRoot, mdPath), "# Title\n\nOriginal paragraph.\n", "utf-8");
	const range = computeSuggestionRange("Original paragraph.", "Updated paragraph.");
	assert.deepEqual(range, { start: 0, end: 8 });
	const snapshot = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snapshot);
	const ref = snapshot.blocks[1].ref;

	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: 0,
		by: "human",
		ops: [{
			type: "suggestion.add",
			ref,
			kind: "replace",
			markdown: "Updated paragraph.",
			range,
		}],
	});
	assert.ok(added.ok, `add: ${JSON.stringify(added)}`);
	const suggestionId = added.ok ? added.snapshot.suggestions[0]?.id : undefined;
	assert.ok(suggestionId);

	const accepted = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: suggestionId! }],
	});
	assert.ok(accepted.ok, `accept: ${JSON.stringify(accepted)}`);
	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.deepEqual(sidecar?.archivedSuggestions[0]?.range, range);
});
