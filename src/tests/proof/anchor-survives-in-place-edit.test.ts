/**
 * An anchor must still find its block when the block's text changed elsewhere in it.
 *
 * Refs are content-derived, so editing any part of a block rewrites its hash and it
 * comes back under a NEW ref. An anchor keeps naming the ref its block held BEFORE the
 * edit, so resolution has to follow the slot across that rehash — `prevRefOrder` is
 * what records which slot that was.
 *
 * This was broken in a way that lost data rather than merely failing to paint. The
 * accept path resolves an anchor only to find the block, then three-way merges the
 * suggestion's `baseMarkdown` against the block's current text. When resolution said
 * `lost`, the lookup returned -1, the merge was skipped, and the suggestion's text was
 * written over a concurrent edit that the merge existed to preserve.
 *
 * The distinction these tests pin is narrow and load-bearing: following the slot is
 * only safe when a reparse actually recorded a previous ordering. Following it off the
 * current `refMap` key order would attach an annotation to whatever block happens to
 * sit at that index — a stranger — which is worse than losing it.
 *
 * `anchor-resolution.test.ts` case 3c pins the other side of that: a displaced block
 * with no recorded ordering must stay `lost`.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { readSidecar } from "../../lib/proof/sidecar.js";
import { parseBlocks } from "../../lib/proof/blocks.js";
import { assignRefs } from "../../lib/proof/block-refs.js";
import { resolveAnchor } from "../../lib/proof/anchor.js";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "wiki-anchor-inplace-"));
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Seed a file with one comment anchor, then rewrite the block elsewhere in it. */
async function seedWithConcurrentEdit(name: string, base: string, concurrent: string): Promise<{ anchorId: string; ref: string }> {
	await writeFile(path.join(root, name), `# Title\n\n${base}\n`, "utf-8");
	const snapshot = await readSnapshot(root, name);
	assert.ok(snapshot, "snapshot");
	const ref = snapshot.blocks[1].ref;
	const added = await applyOps({ rootDir: root, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.add", ref, text: "Review this", textAnchor: { start: 0, end: base.length, selectedText: base } }] });
	assert.ok(added.ok, `add: ${JSON.stringify(added)}`);
	const sc = await readSidecar(root, name);
	const anchorId = sc?.comments[0]?.anchorId ?? "";
	assert.ok(anchorId, "an anchor id");
	const concurrentResult = await applyOps({ rootDir: root, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "block.replace", ref, markdown: concurrent } as never] });
	assert.ok(concurrentResult.ok, `concurrent: ${JSON.stringify(concurrentResult)}`);
	return { anchorId, ref };
}

test("an anchor resolves after an edit elsewhere in its own block", async () => {
	const name = "in-place.md";
	const { anchorId } = await seedWithConcurrentEdit(name, "alpha beta gamma", "alpha beta GAMMA");

	const sc = await readSidecar(root, name);
	assert.ok(sc, "sidecar");
	const anchor = sc.anchors[anchorId];
	assert.ok(anchor, "the anchor record");

	// The quote is GONE from the block, but the block is the same slot.
	const { blocks } = assignRefs(parseBlocks("# Title\n\nalpha beta GAMMA\n"), sc);
	const resolved = resolveAnchor(sc, anchor, blocks);

	assert.notEqual(resolved.status, "lost", "the block is still findable");
	assert.equal(resolved.ref, blocks[1].ref, "and it is the block that took the slot");
	// No position was invented: the span could not be located.
	assert.equal(resolved.offset, 0, "offset is not guessed");
	assert.equal(resolved.length, 0, "length is not guessed");
});

