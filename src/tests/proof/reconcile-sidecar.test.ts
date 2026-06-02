/**
 * Tests for the extracted reconcileSidecar function.
 * Verifies: refMap rebuild, revision bump, fingerprint update, event emission,
 * stale-anchor marking on orphaned refs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import { reconcileSidecar } from "../../lib/proof/ops-applier.js";
import { emptySidecar, writeSidecar, readSidecar } from "../../lib/proof/sidecar.js";

function sha256(content: string): string {
	return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-reconcile-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

test("reconcileSidecar: bumps revision, sets fingerprint, emits file.externallyEdited, writes sidecar", async () => {
	const mdPath = "notes.md";
	const absPath = path.join(tmpRoot, mdPath);
	const content = "# Hello\n\nWorld paragraph.\n";
	await writeFile(absPath, content, "utf-8");

	const sidecar = emptySidecar(mdPath);
	sidecar.fingerprint = sha256("old content that changed");
	const oldRevision = sidecar.revision;

	const fingerprint = sha256(content);
	const { snapshot, blocks } = await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content,
		sidecar,
		by: "system",
		eventType: "file.externallyEdited",
		fingerprint,
	});

	// Revision bumped
	assert.equal(sidecar.revision, oldRevision + 1);
	// Fingerprint updated
	assert.equal(sidecar.fingerprint, fingerprint);
	// refMap has entries for the blocks
	assert.ok(Object.keys(sidecar.refMap).length > 0, "refMap should be non-empty");
	// Event emitted
	assert.equal(sidecar.events.length, 1);
	assert.equal(sidecar.events[0].type, "file.externallyEdited");
	assert.equal(sidecar.events[0].by, "system");
	// Sidecar written to disk
	const onDisk = await readSidecar(tmpRoot, mdPath);
	assert.ok(onDisk, "sidecar should be written to disk");
	assert.equal(onDisk!.revision, oldRevision + 1);
	// Snapshot returned
	assert.equal(snapshot.path, mdPath);
	assert.equal(snapshot.revision, oldRevision + 1);
	assert.equal(snapshot.fingerprint, fingerprint);
	// Blocks returned
	assert.ok(blocks.length > 0, "blocks should be non-empty");
});

test("reconcileSidecar: emits file.rawWritten with oldSha + newSha when eventType is rawWritten", async () => {
	const mdPath = "raw-notes.md";
	const absPath = path.join(tmpRoot, mdPath);
	const content = "# Raw write\n\nNew content.\n";
	await writeFile(absPath, content, "utf-8");

	const sidecar = emptySidecar(mdPath);
	const oldSha = sha256("old content");
	sidecar.fingerprint = oldSha;

	const newSha = sha256(content);
	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content,
		sidecar,
		by: "ai:test-agent",
		eventType: "file.rawWritten",
		fingerprint: newSha,
	});

	assert.equal(sidecar.events.length, 1);
	const ev = sidecar.events[0];
	assert.equal(ev.type, "file.rawWritten");
	assert.equal(ev.by, "ai:test-agent");
	assert.equal(ev.oldSha, oldSha);
	assert.equal(ev.newSha, newSha);
});

test("reconcileSidecar: marks pending suggestions stale when ref no longer in new refMap", async () => {
	const mdPath = "stale-anchors.md";
	const absPath = path.join(tmpRoot, mdPath);

	// Original content with two paragraphs
	const original = "# Doc\n\nParagraph one.\n\nParagraph two.\n";
	await writeFile(absPath, original, "utf-8");

	const sidecar = emptySidecar(mdPath);
	// Add a pending suggestion referencing a fictional ref that won't exist after reparse
	sidecar.suggestions.push({
		id: "s0001",
		ref: "b_orphan_ref",
		kind: "replace",
		status: "pending",
		by: "ai:test",
		markdown: "replacement",
		createdAt: new Date().toISOString(),
	});
	// Add a comment referencing a valid ref — will be assigned after reconcile
	// For simplicity, leave it pointing at another ghost ref too
	sidecar.comments.push({
		id: "c0001",
		ref: "b_also_orphaned",
		resolved: false,
		createdAt: new Date().toISOString(),
		turns: [{ by: "human", text: "comment", at: new Date().toISOString() }],
	});

	const newContent = "# Doc\n\nTotally new content only.\n";
	await writeFile(absPath, newContent, "utf-8");
	const fingerprint = sha256(newContent);

	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content: newContent,
		sidecar,
		by: "ai:agent",
		eventType: "file.rawWritten",
		fingerprint,
	});

	// Both orphaned anchors should be marked stale
	const staleSuggestion = sidecar.suggestions.find((s) => s.id === "s0001");
	assert.equal(staleSuggestion?.stale, true, "suggestion with orphaned ref should be stale");

	const staleComment = sidecar.comments.find((c) => c.id === "c0001");
	assert.equal(staleComment?.stale, true, "comment with orphaned ref should be stale");
});

test("reconcileSidecar: does NOT mark resolved comments or non-pending suggestions stale", async () => {
	const mdPath = "not-stale.md";
	const absPath = path.join(tmpRoot, mdPath);
	const content = "# Head\n\nPara.\n";
	await writeFile(absPath, content, "utf-8");

	const sidecar = emptySidecar(mdPath);
	// Resolved comment with orphaned ref — should NOT be marked stale
	sidecar.comments.push({
		id: "c_resolved",
		ref: "b_orphan",
		resolved: true,
		createdAt: new Date().toISOString(),
		turns: [],
	});
	// Accepted suggestion with orphaned ref — should NOT be marked stale
	sidecar.archivedSuggestions.push({
		id: "s_accepted",
		ref: "b_orphan",
		kind: "replace",
		status: "accepted",
		by: "ai:test",
		createdAt: new Date().toISOString(),
	});

	const fingerprint = sha256(content);
	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content,
		sidecar,
		by: "system",
		eventType: "file.externallyEdited",
		fingerprint,
	});

	const comment = sidecar.comments.find((c) => c.id === "c_resolved");
	assert.equal(comment?.stale, undefined, "resolved comment should not be marked stale");

	// archivedSuggestions are not checked by markOrphanedRefsStale
	const suggestion = sidecar.archivedSuggestions.find((s) => s.id === "s_accepted");
	assert.equal(suggestion?.stale, undefined, "accepted suggestion should not be marked stale");
});
