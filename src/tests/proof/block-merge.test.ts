import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeBlock } from "../../lib/proof/block-merge.js";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-block-merge-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

function assertMerged(base: string, proposed: string, current: string, merged: string): void {
	assert.deepEqual(mergeBlock(base, proposed, current), { ok: true, merged });
}

test("mergeBlock merges disjoint word edits", () => {
	assertMerged(
		"alpha beta gamma",
		"alpha BETA gamma",
		"alpha beta GAMMA",
		"alpha BETA GAMMA",
	);
});

test("mergeBlock refuses overlapping edits", () => {
	assert.deepEqual(
		mergeBlock("alpha beta", "alpha BETA", "alpha GAMMA"),
		{ ok: false, reason: "conflict" },
	);
});

test("mergeBlock returns proposed when base equals current", () => {
	assert.deepEqual(mergeBlock("same", "proposed", "same"), {
		ok: true,
		merged: "proposed",
	});
});

test("mergeBlock preserves whitespace and punctuation around disjoint edits", () => {
	assertMerged(
		"Hello, world.",
		"Hello, brave world.",
		"Hello, world!",
		"Hello, brave world!",
	);
});


