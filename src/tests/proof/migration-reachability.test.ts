/**
 * Migration must actually RUN in production, not only in tests.
 *
 * The durable-anchor migration lived at `migrateSidecar`, exercised by unit tests
 * that passed `blocks` explicitly. Every production caller of `readSidecar` passes
 * only `(rootDir, relPath)`, so `blocks` was always `[]` — and that is the branch
 * which deliberately does not migrate. The net effect was that a legacy sidecar
 * could sit on disk through any number of reads, writes and saves and never be
 * upgraded, which is exactly the state the rebuild exists to leave behind.
 *
 * A unit test on `migrateSidecar` cannot catch this, because the bug is not in the
 * migration but in whether anything calls it. These tests drive the real entry
 * points and assert on the sidecar that reaches disk.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { readSnapshot, reconcileSidecar } from "../../lib/proof/ops-applier.js";
import { readSidecar, writeSidecar } from "../../lib/proof/sidecar.js";
import type { Sidecar } from "../../lib/proof/types.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-migration-reach-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

function sha256(content: string): string {
	return "sha256:" + createHash("sha256").update(content, "utf-8").digest("hex");
}

/** The sidecar path `writeSidecar` uses, so tests can assert what landed on disk. */
function sidecarPath(mdPath: string): string {
	return path.join(tmpRoot, ".proof", `${mdPath}.json`);
}

const DOC = "# Notes\n\nAlpha paragraph.\n\nBeta paragraph.\n";

/**
 * A legacy v1 sidecar: one comment and one suggestion that carry `textAnchor` and
 * refs but no `anchorId`, and no `schemaVersion` — the shape a document written by
 * the previous implementation is actually in.
 */
function legacySidecar(mdPath: string, ref: string): Sidecar {
	return {
		path: mdPath,
		revision: 3,
		updatedAt: "2026-01-01T00:00:00.000Z",
		fingerprint: sha256(DOC),
		events: [],
		comments: [
			{
				id: "c1",
				ref,
				textAnchor: { selectedText: "Alpha paragraph.", prefix: "", suffix: "" },
				body: "this needs a source",
				author: "human",
				createdAt: "2026-01-01T00:00:00.000Z",
				resolvedAt: null,
				cancelledAt: null,
				cancelReason: null,
			},
		],
		suggestions: [
			{
				id: "s1",
				ref,
				kind: "replace",
				markdown: "Alpha paragraph, revised.",
				baseMarkdown: "Alpha paragraph.",
				status: "pending",
				author: "human",
				createdAt: "2026-01-01T00:00:00.000Z",
				stale: false,
			},
		],
		refMap: {},
		// A real legacy file on disk carries schemaVersion 1 — `readSidecar` throws on
		// anything else, including a missing value. `anchors` is what migration adds.
		schemaVersion: 1,
	} as unknown as Sidecar;
}

async function seedLegacy(mdPath: string): Promise<void> {
	await mkdir(path.join(tmpRoot, ".proof"), { recursive: true });
	await writeFile(path.join(tmpRoot, mdPath), DOC, "utf-8");

	// Take the ref from a real snapshot so the fixture points at a block that exists.
	// The legacy record is identified by its TEXT anchor, which is the whole point:
	// the ref is the fragile identity, the quote is the durable one.
	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap, "snapshot");
	const ref = snap!.blocks[1].ref;
	await writeSidecar(tmpRoot, mdPath, legacySidecar(mdPath, ref));
}

test("REGRESSION: readSnapshot migrates a legacy sidecar instead of leaving it at v1", async () => {
	const mdPath = "migrate-on-read.md";
	await seedLegacy(mdPath);

	const before = await readSidecar(tmpRoot, mdPath);
	assert.equal(
		before?.schemaVersion ?? 1,
		1,
		"precondition: the seeded sidecar must start legacy, or this proves nothing",
	);

	await readSnapshot(tmpRoot, mdPath);

	// Read from DISK, not from the object the call returned. The bug being guarded
	// against is a migration that happens in memory and is thrown away.
	const raw = await readFile(sidecarPath(mdPath), "utf-8");
	const onDisk = JSON.parse(raw) as Sidecar;
	assert.ok(
		(onDisk.schemaVersion ?? 1) >= 2,
		`the read must persist the migration; disk still says ${onDisk.schemaVersion ?? 1}`,
	);
});

test("REGRESSION: reconcileSidecar migrates before it judges annotations by ref", async () => {
	const mdPath = "migrate-on-write.md";
	await seedLegacy(mdPath);

	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar");
	assert.equal(sidecar!.schemaVersion ?? 1, 1, "precondition: starts legacy");

	// An external edit, which is the path that runs ref reconciliation — and that
	// cancels comments when a ref disappears.
	const rewritten = "# Notes\n\nAlpha paragraph.\n\nBeta paragraph, edited outside.\n";
	await writeFile(path.join(tmpRoot, mdPath), rewritten, "utf-8");

	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content: rewritten,
		sidecar: sidecar!,
		by: "system",
		eventType: "file.externallyEdited",
		fingerprint: sha256(rewritten),
	});

	assert.ok(
		(sidecar!.schemaVersion ?? 1) >= 2,
		"reconcileSidecar must migrate before markOrphanedRefsStale runs",
	);

	// The comment's own block is untouched by the edit, so it must survive with an
	// anchor rather than being cancelled for having lost its ref.
	const comment = sidecar!.comments.find((c) => c.id === "c1");
	assert.ok(comment, "the comment is still present");
	assert.equal(comment!.cancelledAt, null, "an untouched block's comment is not cancelled");
	assert.ok(comment!.anchorId, "and it now carries a durable anchor");
});

test("a legacy sidecar whose text is genuinely gone is marked lost, not silently kepty", async () => {
	const mdPath = "migrate-lost.md";
	await seedLegacy(mdPath);

	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar");

	// Rewrite the document so the commented text no longer exists anywhere.
	const rewritten = "# Notes\n\nCompletely different content.\n";
	await writeFile(path.join(tmpRoot, mdPath), rewritten, "utf-8");

	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content: rewritten,
		sidecar: sidecar!,
		by: "system",
		eventType: "file.externallyEdited",
		fingerprint: sha256(rewritten),
	});

	const comment = sidecar!.comments.find((c) => c.id === "c1");
	assert.ok(comment, "the comment is still present rather than dropped");
	// The honest end state: kept for the audit trail, marked as having lost its
	// anchor, never invented an offset it could not verify.
	assert.ok(
		comment!.cancelledAt !== null || comment!.anchorStatus === "lost",
		`a comment whose text is gone must be marked lost, got ${JSON.stringify({
			cancelledAt: comment!.cancelledAt,
			anchorStatus: comment!.anchorStatus,
		})}`,
	);
});