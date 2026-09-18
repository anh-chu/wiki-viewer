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

test("repro-stale-latch: an external edit orphans a block comment and cancels it", async () => {
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

	assert.notEqual(
		latched.stale,
		true,
		"the one-way stale latch is gone; cancellation replaces it",
	);
	assert.equal(latched.resolved, true, "the orphaned comment is cancelled");
	assert.equal(latched.cancelReason, "anchor-lost", "with a recorded reason");
	assert.ok(latched.cancelledAt, "and a timestamp");

	// Cancelled comments are resolved, so they leave the margin column and are not
	// counted as pending work for an agent.
	const stillPending = afterEdit.comments.filter((c) => !c.resolved);
	assert.equal(
		stillPending.length,
		0,
		"a cancelled comment is not pending agent work",
	);

	// The record survives with its reason recorded, so an audit can still explain
	// why a comment went away even though the UI no longer shows it.
	const cancelled = sidecarAfter.comments.filter((c) => c.cancelReason === "anchor-lost");
	assert.equal(cancelled.length, 1, "the cancellation is recorded, not just deleted");
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