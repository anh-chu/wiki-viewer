/**
 * `suggestion.add` with `status: "accepted"` must not delete a block by accident.
 *
 * The op maps its kind to a block-level op so the change applies immediately. That
 * mapping ended in an unconditional `{ type: "block.delete" }` catch-all, so any
 * kind it did not recognise became a DELETION. `insert` and `remove` are exactly
 * such kinds: they describe a run of typed characters at a `range` inside a block,
 * not a whole-block edit, so an agent posting `{kind: "insert", status:
 * "accepted"}` silently destroyed the block it named.
 *
 * These tests pin the refusal and, just as important, that the four legitimate
 * kinds still map where they should — the catch-all is gone, so `replace` must
 * still be a replace rather than falling into the delete branch.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-sug-add-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

const DOC = "# Notes\n\nAlpha paragraph.\n\nBeta paragraph.\n";

async function seed(name: string): Promise<{ mdPath: string; ref: string; revision: number }> {
	const mdPath = name;
	await writeFile(path.join(tmpRoot, mdPath), DOC, "utf-8");
	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap, "snapshot");
	const block = snap.blocks.find((b) => b.markdown.includes("Beta"))!;
	return { mdPath, ref: block.ref, revision: snap.revision };
}

test("kind \"insert\" with status accepted is refused, not turned into a deletion", async () => {
	const { mdPath, ref, revision } = await seed("insert-accepted.md");

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: revision,
		by: "ai:agent",
		ops: [
			{
				type: "suggestion.add",
				ref,
				kind: "insert",
				markdown: "inserted text",
				range: { start: 0, end: 0 },
				status: "accepted",
			} as never,
		],
	});

	assert.equal(res.ok, false, "the op is refused rather than applied");
	assert.equal(
		(res as { code?: string }).code,
		"UNSUPPORTED_SUGGESTION_KIND",
		"and says why",
	);

	// The load-bearing assertion: the block is still there.
	const after = await readFile(path.join(tmpRoot, mdPath), "utf-8");
	assert.ok(after.includes("Beta paragraph."), "the named block was NOT deleted");
});

test("kind \"remove\" with status accepted is refused too", async () => {
	const { mdPath, ref, revision } = await seed("remove-accepted.md");

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: revision,
		by: "ai:agent",
		ops: [
			{
				type: "suggestion.add",
				ref,
				kind: "remove",
				markdown: "",
				range: { start: 0, end: 5 },
				status: "accepted",
			} as never,
		],
	});

	assert.equal(res.ok, false, "refused");
	const after = await readFile(path.join(tmpRoot, mdPath), "utf-8");
	assert.ok(after.includes("Beta paragraph."), "the block survives");
});

test("CONTROL: kind \"replace\" with status accepted still replaces", async () => {
	// Without this, the refusal above could be satisfied by refusing everything.
	const { mdPath, ref, revision } = await seed("replace-accepted.md");

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: revision,
		by: "ai:agent",
		ops: [
			{
				type: "suggestion.add",
				ref,
				kind: "replace",
				markdown: "Gamma paragraph.",
				status: "accepted",
			} as never,
		],
	});

	assert.ok(res.ok, `replace is still accepted: ${JSON.stringify(res)}`);
	const after = await readFile(path.join(tmpRoot, mdPath), "utf-8");
	assert.ok(after.includes("Gamma paragraph."), "the replacement landed");
	assert.ok(!after.includes("Beta paragraph."), "and the old text is gone");
	assert.ok(after.includes("Alpha paragraph."), "the neighbouring block is untouched");
});

test("CONTROL: kind \"delete\" with status accepted still deletes", async () => {
	const { mdPath, ref, revision } = await seed("delete-accepted.md");

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: revision,
		by: "ai:agent",
		ops: [{ type: "suggestion.add", ref, kind: "delete", status: "accepted" } as never],
	});

	assert.ok(res.ok, "delete is still accepted");
	const after = await readFile(path.join(tmpRoot, mdPath), "utf-8");
	assert.ok(!after.includes("Beta paragraph."), "the block was deleted, as asked");
	assert.ok(after.includes("Alpha paragraph."), "and nothing else was");
});
