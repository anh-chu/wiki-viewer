/**
 * PHASE 6 acceptance — an orphaned anchor is VISIBLE, EXPLAINED and RECOVERABLE
 * (DoD #6), and staleness has a reset site.
 *
 * repro-stale-latch.test.ts pins the broken behaviour: stale latches on, both
 * consumers skip it, and nothing can clear it. This file pins the fix.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { readSidecar } from "../../lib/proof/sidecar.js";
import {
	reportOrphans,
	reanchorComment,
	planRecovery,
	anchorStillValid,
} from "../../lib/proof/orphan-recovery.js";
import type { Block, Comment } from "../../lib/proof/types.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-orphan-recovery-"));
});
after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

const BLOCKS: Block[] = [
	{ ref: "b111111", type: "paragraph", markdown: "The quick brown fox jumps." },
	{ ref: "b222222", type: "paragraph", markdown: "A second paragraph lives here." },
];

test("P6: an orphaned comment is reported with an explanation and its text", () => {
	const comments: Comment[] = [
		{
			id: "c1",
			ref: "bgone00",
			resolved: false,
			stale: true,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "explain", at: "2026-09-18T00:00:00Z" }],
			textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
		},
	];

	const report = reportOrphans(comments, []);
	assert.equal(report.orphaned.length, 1, "DoD #6: the orphan is surfaced, not hidden");
	assert.equal(report.orphaned[0].kind, "comment");
	assert.equal(report.orphaned[0].selectedText, "quick brown", "the text is shown to the user");
	assert.ok(report.orphaned[0].reason.length > 0, "the state is explained, not just flagged");
	assert.equal(report.orphaned[0].recoverable, true, "and recovery is possible");
	assert.deepEqual(report.missingRefs, ["bgone00"]);
});

test("P6: a legacy block-only orphan is reported but honestly marked unrecoverable", () => {
	// No stored text means nothing to search for. Reporting it as recoverable
	// would be a lie the UI would then fail to honour.
	const comments: Comment[] = [
		{
			id: "c2",
			ref: "bgone00",
			resolved: false,
			stale: true,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
		},
	];
	const report = reportOrphans(comments, []);
	assert.equal(report.orphaned.length, 1);
	assert.equal(report.orphaned[0].recoverable, false, "no text → not auto-recoverable");
});

test("P6: a stale comment is re-anchored by searching for its text", () => {
	const comment: Comment = {
		id: "c3",
		ref: "bgone00", // the old block is gone
		resolved: false,
		stale: true,
		createdAt: "2026-09-18T00:00:00Z",
		turns: [{ by: "human", text: "explain", at: "2026-09-18T00:00:00Z" }],
		textAnchor: { start: 0, end: 11, selectedText: "quick brown", baseMarkdown: "old text" },
	};

	const result = reanchorComment(comment, BLOCKS);
	assert.equal(result.status, "recovered", "DoD #6: the anchor is recoverable");
	assert.equal(result.ref, "b111111", "it landed in the block that now holds the text");
	assert.ok(result.anchor);
	assert.equal(
		BLOCKS[0].markdown.slice(result.anchor.start, result.anchor.end),
		"quick brown",
		"the new offsets are valid for the CURRENT markdown",
	);
});

test("P6: recovery follows text that moved into a DIFFERENT block", () => {
	// An external edit may move the paragraph entirely. Recovery searches all
	// blocks, not just the original ref — which is what makes it useful.
	const moved: Block[] = [
		{ ref: "b999999", type: "paragraph", markdown: "Totally unrelated content." },
		{ ref: "b888888", type: "paragraph", markdown: "Now the quick brown fox is here." },
	];
	const comment: Comment = {
		id: "c4",
		ref: "bgone00",
		resolved: false,
		stale: true,
		createdAt: "2026-09-18T00:00:00Z",
		turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
		textAnchor: { start: 0, end: 11, selectedText: "quick brown" },
	};

	const result = reanchorComment(comment, moved);
	assert.equal(result.status, "recovered");
	assert.equal(result.ref, "b888888", "recovery follows the text to its new block");
});

test("P6: text that is genuinely gone is reported not-found, never mis-anchored", () => {
	const comment: Comment = {
		id: "c5",
		ref: "bgone00",
		resolved: false,
		stale: true,
		createdAt: "2026-09-18T00:00:00Z",
		turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
		textAnchor: { start: 0, end: 19, selectedText: "vanished entirely!!" },
	};
	const result = reanchorComment(comment, BLOCKS);
	assert.equal(result.status, "not-found");
});

test("P6: planRecovery batches recoverable orphans and skips the rest", () => {
	const comments: Comment[] = [
		{
			id: "c-recoverable",
			ref: "bgone00",
			resolved: false,
			stale: true,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
			textAnchor: { start: 0, end: 11, selectedText: "quick brown" },
		},
		{
			id: "c-gone",
			ref: "bgone00",
			resolved: false,
			stale: true,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
			textAnchor: { start: 0, end: 5, selectedText: "zzzzz" },
		},
		{
			id: "c-fine",
			ref: "b111111",
			resolved: false,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
			textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
		},
	];

	const plan = planRecovery(comments, BLOCKS);
	assert.equal(plan.length, 1, "only the recoverable orphan is planned");
	assert.equal(plan[0].commentId, "c-recoverable");
});

test("P6: anchorStillValid distinguishes a live anchor from a stale one", () => {
	const live: Comment = {
		id: "c6",
		ref: "b111111",
		resolved: false,
		createdAt: "2026-09-18T00:00:00Z",
		turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
		textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
	};
	assert.equal(anchorStillValid(live, BLOCKS), true);

	const drifted: Comment = {
		...live,
		id: "c7",
		textAnchor: { start: 0, end: 11, selectedText: "quick brown" },
	};
	assert.equal(
		anchorStillValid(drifted, BLOCKS),
		true,
		"drifted-but-findable counts as valid — recovery is automatic, not a user burden",
	);

	const gone: Comment = {
		...live,
		id: "c8",
		textAnchor: { start: 0, end: 5, selectedText: "zzzzz" },
	};
	assert.equal(anchorStillValid(gone, BLOCKS), false);
});

test("P6: END-TO-END — an external edit orphans, then recovery restores the anchor", async () => {
	// The full journey the user actually experiences, through the real op path.
	const mdPath = "e2e.md";
	await writeFile(
		path.join(tmpRoot, mdPath),
		"# Title\n\nThe quick brown fox jumps.\n\nKeep this paragraph.\n",
		"utf-8",
	);

	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap);
	const target = snap.blocks[1];
	assert.equal(target.markdown, "The quick brown fox jumps.");

	// Comment on the exact words "quick brown".
	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: snap.revision,
		by: "human",
		ops: [
			{
				type: "comment.add",
				ref: target.ref,
				text: "should this be 'fast brown'?",
				textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
			},
		],
	});
	assert.ok(added.ok, `comment.add accepted: ${JSON.stringify(added)}`);

	const stored = (await readSidecar(tmpRoot, mdPath))?.comments[0];
	assert.ok(stored?.textAnchor, "the text anchor round-tripped through the op path");

	// External edit: the commented block is REWRITTEN, but the anchored phrase
	// survives inside a later block. That is the realistic recovery case — the
	// ref is orphaned (its content hash is gone) while the text is still there.
	await writeFile(
		path.join(tmpRoot, mdPath),
		"# Title\n\nA completely rewritten sentence appears.\n\nLater: the quick brown fox jumps.\n",
		"utf-8",
	);
	await readSnapshot(tmpRoot, mdPath);

	const afterEdit = await readSidecar(tmpRoot, mdPath);
	const staleComment = afterEdit?.comments.find((c) => c.id === stored.id);
	assert.equal(staleComment?.stale, true, "the edit orphaned the anchor (repro #3 behaviour)");

	// Now: SURFACED.
	const report = reportOrphans(afterEdit?.comments ?? [], afterEdit?.suggestions ?? []);
	assert.equal(report.orphaned.length, 1, "DoD #6: it is visible, not silently hidden");

	// And: RECOVERABLE.
	const fresh = await readSnapshot(tmpRoot, mdPath);
	assert.ok(fresh);
	const plan = planRecovery(afterEdit?.comments ?? [], fresh.blocks);
	assert.equal(plan.length, 1, "DoD #6: recovery is planned against the CURRENT document");
	const recovered = fresh.blocks.find((b) => b.ref === plan[0].ref);
	assert.ok(recovered, "the recovery target exists in the current document");
	assert.equal(
		recovered.markdown.slice(plan[0].anchor.start, plan[0].anchor.end),
		"quick brown",
		"and the re-minted offsets are valid",
	);
});
test("P6: comment.reanchor CLEARS the stale latch through the real op path", async () => {
	// DoD #6's actual requirement: the latch must be reversible. Before the
	// comment.reanchor op existed there was no reset site for a block-ref
	// comment, which is what made the orphan permanent.
	const mdPath = "reset.md";
	await writeFile(
		path.join(tmpRoot, mdPath),
		"# Title\n\nThe quick brown fox jumps.\n\nStable paragraph.\n",
		"utf-8",
	);

	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap);
	const added = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: snap.revision,
		by: "human",
		ops: [
			{
				type: "comment.add",
				ref: snap.blocks[1].ref,
				text: "check this",
				textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
			},
		],
	});
	assert.ok(added.ok, `comment.add accepted: ${JSON.stringify(added)}`);
	const commentId = (await readSidecar(tmpRoot, mdPath))!.comments[0].id;

	// External edit orphans it.
	await writeFile(
		path.join(tmpRoot, mdPath),
		"# Title\n\nRewritten entirely.\n\nStable paragraph.\n",
		"utf-8",
	);
	await readSnapshot(tmpRoot, mdPath);
	assert.equal(
		(await readSidecar(tmpRoot, mdPath))!.comments[0].stale,
		true,
		"precondition: the comment is latched stale",
	);

	// A valid re-anchor is REJECTED while the text is absent — no false recovery.
	const orphanedSnap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(orphanedSnap);
	const bogus = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: orphanedSnap.revision,
		by: "human",
		ops: [
			{
				type: "comment.reanchor",
				commentId,
				ref: orphanedSnap.blocks[1].ref,
				textAnchor: { start: 0, end: 11, selectedText: "quick brown" },
			},
		],
	});
	assert.equal(bogus.ok, false, "an anchor whose text is absent must be rejected");
	assert.equal(bogus.ok === false && bogus.status, 400);

	// Restore the text in a later block, then recover for real.
	await writeFile(
		path.join(tmpRoot, mdPath),
		"# Title\n\nRewritten entirely.\n\nLater: the quick brown fox jumps.\n",
		"utf-8",
	);
	const fresh = await readSnapshot(tmpRoot, mdPath);
	assert.ok(fresh);

	const report = reportOrphans(
		(await readSidecar(tmpRoot, mdPath))!.comments,
		(await readSidecar(tmpRoot, mdPath))!.suggestions,
	);
	assert.equal(report.orphaned.length, 1, "surfaced before recovery");

	const plan = planRecovery((await readSidecar(tmpRoot, mdPath))!.comments, fresh.blocks);
	assert.equal(plan.length, 1, "a recovery is planned");

	const recovered = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: fresh.revision,
		by: "human",
		ops: [
			{
				type: "comment.reanchor",
				commentId: plan[0].commentId,
				ref: plan[0].ref,
				textAnchor: plan[0].anchor,
			},
		],
	});
	assert.ok(recovered.ok, `comment.reanchor accepted: ${JSON.stringify(recovered)}`);

	const finalSidecar = await readSidecar(tmpRoot, mdPath);
	const healed = finalSidecar!.comments.find((c) => c.id === commentId);
	assert.ok(healed);
	assert.equal(healed.stale, undefined, "DoD #6: THE LATCH IS CLEARED — recovery works");
	assert.ok(healed.textAnchor, "and the anchor is re-minted");
	assert.equal(healed.textAnchor.selectedText, "quick brown");

	// It renders again, which is the user-visible outcome.
	assert.equal(
		reportOrphans(finalSidecar!.comments, finalSidecar!.suggestions).orphaned.length,
		0,
		"the annotation is no longer orphaned",
	);
});
