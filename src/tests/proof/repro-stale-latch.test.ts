/**
 * PHASE 1 REPRO #3 — the staleness one-way latch.
 *
 * FINDING (the one that survived falsification in the research session):
 * `markOrphanedRefsStale` (ops-applier.ts:119) sets `comment.stale = true` /
 * `suggestion.stale = true` when a ref disappears. But:
 *
 *   - the ONLY two un-stale sites are in `reconcileTextCommentAnchors`, and both
 *     are reachable ONLY via `lineAnchor` — block-ref comments have no path back;
 *   - no UI, list, count or API surfaces `stale`;
 *   - `suggestion-decorator.ts:85` and `editor.tsx:235` both SKIP stale entries,
 *     so the annotation silently disappears.
 *
 * Net effect: an external edit makes annotations vanish with no signal and no
 * recovery. This file pins that current behaviour; Phase 6 adds the acceptance
 * criteria (visible, explained, recoverable) in `stale-recovery.test.ts`.
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

test("repro-stale-latch: an external edit orphans a block comment and SILENTLY hides it", async () => {
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

	assert.equal(
		latched.stale,
		true,
		"DOCUMENTS CURRENT BEHAVIOUR (DoD #6): the external edit latches stale=true",
	);

	// Consumers skip stale entries, so the annotation disappears with no signal.
	const visibleToUi = afterEdit.comments.filter((c) => !c.stale);
	assert.equal(
		visibleToUi.length,
		0,
		"BUG (DoD #6): zero comments are visible to the pip/decorator path",
	);

	// The record is still there, so it is recoverable *in principle* — but the
	// product exposes no reset site, no list, no count, and no re-anchor action.
	const orphaned = sidecarAfter.comments.filter((c) => c.stale);
	assert.equal(orphaned.length, 1, "the orphan is discoverable only by reading raw records");
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