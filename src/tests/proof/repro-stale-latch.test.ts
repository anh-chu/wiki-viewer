/**
 * PHASE 1 REPRO #3 — annotations when an external edit orphans their anchor.
 *
 * ORIGINAL FINDING: `markOrphanedRefsStale` latched `comment.stale = true` when a
 * ref disappeared, and nothing ever cleared it — block-ref comments had no path
 * back, and no UI surfaced the flag. The annotation simply vanished.
 *
 * RESOLUTION: the latch is gone. An orphaned comment is now CANCELLED — marked
 * resolved with `cancelReason: "anchor-lost"` — which is the behaviour the user
 * chose over a recovery UI. It disappears deliberately rather than silently, and
 * because it is resolved it can no longer feed a phantom instruction into
 * Copy-as-prompt.
 *
 * The CONTROL test below is unchanged and still load-bearing: it proves the
 * cancellation fires only for a genuinely orphaned anchor, not on any edit.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { readSidecar } from "../../lib/proof/sidecar.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-repro-stale-"));
});
after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

test("repro-stale-latch: an external edit does not destroy a block comment", async () => {
	const mdPath = "latch.md";
	await writeDoc(mdPath, "# Title\n\nThe quick brown fox jumps.\n\nSecond paragraph here.\n");

	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap, "initial snapshot");
	const targetBlock = snap.blocks[2];
	assert.ok(targetBlock, "the second paragraph block exists");

	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: snap.revision,
		by: "human",
		ops: [{ type: "comment.add", ref: targetBlock.ref, text: "please expand this" }],
	});
	assert.ok(added.ok, `comment.add succeeded: ${JSON.stringify(added)}`);

	const afterAdd = await readSidecar(tmpRoot, mdPath);
	assert.ok(afterAdd, "sidecar after add");
	const comment = afterAdd.comments[0];
	assert.ok(comment, "comment was created");
	assert.ok(!comment.stale, "freshly created comment is not stale");

	// External edit: the commented block's text is replaced wholesale, so its
	// content-hash ref no longer exists in the document.
	await writeDoc(
		mdPath,
		"# Title\n\nThe quick brown fox jumps.\n\nCOMPLETELY DIFFERENT TEXT.\n",
	);
	const afterEdit = await readSnapshot(tmpRoot, mdPath);
	assert.ok(afterEdit, "snapshot after external edit triggers reconcile");

	const sidecarAfter = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecarAfter);
	const latched = sidecarAfter.comments.find((c) => c.id === comment.id);
	assert.ok(latched, "the comment record still exists in the sidecar");

	// This comment was added with no selection, so it is BLOCK-granular: it annotates
	// the second paragraph as a whole, not a span of words inside it. Rewriting that
	// paragraph's text therefore does not orphan it — the paragraph is still there
	// and the comment still belongs to it. `anchor-e2e.test.ts` pins the same
	// contract from the other direction: a block comment follows its block across a
	// rewrite.
	//
	// What the old code did here was worse than wrong, it was destructive: the ref
	// died with the content hash, so the comment was CANCELLED — something the user
	// wrote, deleted because somebody saved the file elsewhere. Two rejected designs
	// are worth naming. Latching `stale = true` parked it forever waiting on a
	// re-anchor UI nobody built. Cancelling dropped it unrecoverably. Following
	// Google Docs, the card stays.
	assert.notEqual(
		latched.stale,
		true,
		"the one-way stale latch is gone",
	);
	assert.notEqual(latched.resolved, true, "a surviving comment is not resolved");
	assert.equal(latched.cancelledAt, undefined, "and it is never cancelled");
	assert.equal(latched.cancelReason, undefined, "so it carries no cancel reason");

	const visible = sidecarAfter.comments.filter((c) => !c.cancelledAt);
	assert.equal(visible.length, 1, "the comment keeps its card rather than vanishing");
});

test("repro-stale-latch: a comment on a deleted SELECTION is marked lost, not destroyed", async () => {
	// The genuine orphan case the block-granular test above does not cover: a comment
	// on a span of words, when those words are deleted. Its anchor has a real quote,
	// so the resolver searches for it and reports `lost` when it is truly gone.
	const mdPath = "lost-selection.md";
	await writeDoc(mdPath, "# Title\n\nThe quick brown fox jumps.\n");

	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap);
	const block = snap.blocks[1];

	await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: snap.revision,
		by: "human",
		ops: [
			{
				type: "comment.add",
				ref: block.ref,
				text: "about the fox",
				textAnchor: { start: 16, end: 19, selectedText: "fox" },
			} as never,
		],
	});

	const after = await readSidecar(tmpRoot, mdPath);
	const comment = after!.comments[0];
	assert.ok(comment, "comment created");
	assert.ok(comment.anchorId, "a selection comment carries an anchor");

	// Delete the commented words entirely.
	await writeDoc(mdPath, "# Title\n\nThe quick brown cat jumps.\n");
	await readSnapshot(tmpRoot, mdPath);

	const later = await readSidecar(tmpRoot, mdPath);
	const lost = later!.comments.find((c) => c.id === comment.id);
	assert.ok(lost, "the comment is still on the record");
	assert.equal(lost!.anchorStatus, "lost", "its quote is gone, so it is marked lost");
	assert.notEqual(lost!.resolved, true, "but it is not resolved");
	assert.equal(lost!.cancelledAt, undefined, "and not cancelled");
});

test("repro-stale-latch: CONTROL — appending unrelated content does not orphan a comment", async () => {
	// The control test. Without it we could "confirm" a bug that also fires on
	// harmless edits. Method lesson: test through the real entry point.
	const mdPath = "control.md";
	const original = "# Title\n\nFirst para.\n\nSecond para stays put.\n";
	await writeDoc(mdPath, original);

	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap);
	const target = snap.blocks[2];

	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: snap.revision,
		by: "human",
		ops: [{ type: "comment.add", ref: target.ref, text: "note" }],
	});
	assert.ok(added.ok, `comment.add succeeded: ${JSON.stringify(added)}`);

	const beforeEdit = await readSidecar(tmpRoot, mdPath);
	assert.ok(beforeEdit);
	const commentId = beforeEdit.comments[0].id;

	// Append a new trailing block; the commented block is untouched.
	await writeDoc(mdPath, `${original}\n\nA brand new trailing paragraph.\n`);
	const after = await readSnapshot(tmpRoot, mdPath);
	assert.ok(after);

	const sidecarAfter = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecarAfter);
	const c = sidecarAfter.comments.find((x) => x.id === commentId);
	assert.ok(c, "comment survives a harmless append");
	assert.ok(
		!c.stale,
		"CONTROL: appending unrelated content must NOT orphan the anchor",
	);
	assert.equal(
		after.comments.filter((x) => !x.stale).length,
		1,
		"CONTROL: the comment is still visible after a harmless append",
	);
});