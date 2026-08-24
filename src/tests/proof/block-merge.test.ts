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

async function addRangedSuggestion(
	name: string,
	base: string,
	proposed: string,
): Promise<{ ref: string; id: string }> {
	await writeFile(path.join(tmpRoot, name), `# Title\n\n${base}\n`, "utf-8");
	const snapshot = await readSnapshot(tmpRoot, name);
	assert.ok(snapshot);
	const ref = snapshot.blocks[1].ref;
	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{
			type: "suggestion.add",
			ref,
			kind: "replace",
			markdown: proposed,
			range: { start: 0, end: base.length },
			baseMarkdown: base,
		}],
	});
	assert.ok(added.ok, `add: ${JSON.stringify(added)}`);
	const id = added.ok ? added.snapshot.suggestions[0]?.id : undefined;
	assert.ok(id);
	return { ref, id };
}

async function accept(name: string, id: string, baseRevision: number) {
	return applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: id }],
	});
}

test("ranged accept merges concurrent edit elsewhere in block", async () => {
	const name = "merge-concurrent.md";
	const { ref, id } = await addRangedSuggestion(name, "alpha beta gamma", "alpha BETA gamma");
	const concurrent = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.replace", ref, markdown: "alpha beta GAMMA" }],
	});
	assert.ok(concurrent.ok);

	const result = await accept(name, id, 1);
	assert.ok(result.ok, `accept: ${JSON.stringify(result)}`);
	assert.equal(await readFile(path.join(tmpRoot, name), "utf-8"), "# Title\n\nalpha BETA GAMMA\n");
});

test("ranged accept refuses overlapping concurrent edit without writing", async () => {
	const name = "merge-conflict.md";
	const { ref, id } = await addRangedSuggestion(name, "alpha beta gamma", "alpha BETA gamma");
	const concurrent = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.replace", ref, markdown: "alpha GAMMA gamma" }],
	});
	assert.ok(concurrent.ok);
	const before = await readFile(path.join(tmpRoot, name), "utf-8");

	const result = await accept(name, id, 1);
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.status, 409);
	assert.equal(await readFile(path.join(tmpRoot, name), "utf-8"), before);
	const snapshot = await readSnapshot(tmpRoot, name);
	assert.equal(snapshot?.suggestions.some((suggestion) => suggestion.id === id), true);
});

test("ranged accept with no concurrent change keeps whole-block result", async () => {
	const name = "merge-no-concurrent.md";
	const { id } = await addRangedSuggestion(name, "alpha beta", "alpha BETA");
	const result = await accept(name, id, 0);
	assert.ok(result.ok, `accept: ${JSON.stringify(result)}`);
	assert.equal(await readFile(path.join(tmpRoot, name), "utf-8"), "# Title\n\nalpha BETA\n");
});

test("non-ranged accept remains whole-block replacement", async () => {
	const name = "merge-unranged.md";
	await writeFile(path.join(tmpRoot, name), "# Title\n\nOriginal text.\n", "utf-8");
	const snapshot = await readSnapshot(tmpRoot, name);
	assert.ok(snapshot);
	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{
			type: "suggestion.add",
			ref: snapshot.blocks[1].ref,
			kind: "replace",
			markdown: "Whole replacement.",
		}],
	});
	assert.ok(added.ok);
	const id = added.ok ? added.snapshot.suggestions[0]?.id : undefined;
	assert.ok(id);
	const result = await accept(name, id, 0);
	assert.ok(result.ok, `accept: ${JSON.stringify(result)}`);
	assert.equal(await readFile(path.join(tmpRoot, name), "utf-8"), "# Title\n\nWhole replacement.\n");
});
