import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { setRootDir } from "../../lib/root-dir.js";
import { idempotency } from "../../lib/proof/idempotency.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-proof-test-"));
	setRootDir(tmpRoot);
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

async function readDoc(name: string): Promise<string> {
	return readFile(path.join(tmpRoot, name), "utf-8");
}

function hashText(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

test("readSnapshot returns null for missing file", async () => {
	const snap = await readSnapshot(tmpRoot, "nonexistent.md");
	assert.equal(snap, null);
});

test("readSnapshot returns blocks for existing file", async () => {
	await writeDoc("snap-test.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "snap-test.md");
	assert.ok(snap !== null);
	assert.equal(snap!.blocks.length, 2);
	assert.equal(snap!.blocks[0].type, "heading");
	assert.equal(snap!.blocks[1].type, "paragraph");
	assert.equal(snap!.revision, 0);
});

test("block.replace happy path", async () => {
	await writeDoc("replace.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "replace.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "replace.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.replace", ref: paraRef, markdown: "Replaced paragraph." }],
	});

	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
	assert.equal(result.ok ? result.snapshot.revision : -1, 1);
	const content = await readDoc("replace.md");
	assert.ok(content.includes("Replaced paragraph."), `content: ${content}`);
	assert.ok(!content.includes("Original paragraph."), `old content: ${content}`);
});

test("block.insertAfter happy path", async () => {
	await writeDoc("insert.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "insert.md");
	const titleRef = snap!.blocks[0].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "insert.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.insertAfter", ref: titleRef, markdown: "New paragraph." }],
	});

	assert.ok(result.ok);
	const content = await readDoc("insert.md");
	assert.ok(content.includes("New paragraph."), `inserted: ${content}`);
	assert.ok(content.includes("# Title"), `title preserved: ${content}`);
});

test("block.insertBefore happy path", async () => {
	await writeDoc("insertbefore.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "insertbefore.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "insertbefore.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.insertBefore", ref: paraRef, markdown: "Before." }],
	});

	assert.ok(result.ok);
	const content = await readDoc("insertbefore.md");
	assert.ok(content.includes("Before."), `inserted: ${content}`);
});

test("block.delete happy path", async () => {
	await writeDoc("delete.md", "# Title\n\nTo delete.\n\n## Section\n");
	const snap = await readSnapshot(tmpRoot, "delete.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "delete.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.delete", ref: paraRef }],
	});

	assert.ok(result.ok);
	const content = await readDoc("delete.md");
	assert.ok(!content.includes("To delete."), `deleted: ${content}`);
	assert.ok(content.includes("# Title"), `title preserved: ${content}`);
});

test("block.append adds to end", async () => {
	await writeDoc("append.md", "# Title\n");
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "append.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.append", markdown: "Appended." }],
	});

	assert.ok(result.ok);
	const content = await readDoc("append.md");
	assert.ok(content.includes("Appended."), `appended: ${content}`);
});

test("block.prepend adds to start", async () => {
	await writeDoc("prepend.md", "# Title\n");
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "prepend.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.prepend", markdown: "Prepended." }],
	});

	assert.ok(result.ok);
	const content = await readDoc("prepend.md");
	assert.ok(content.startsWith("Prepended."), `prepended: ${content}`);
});

test("STALE_REVISION returned when baseRevision wrong", async () => {
	await writeDoc("stale.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "stale.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "stale.md",
		baseRevision: 99, // wrong
		by: "human",
		ops: [{ type: "block.replace", ref: paraRef, markdown: "New." }],
	});

	assert.ok(!result.ok);
	assert.equal(result.ok ? "" : result.code, "STALE_REVISION");
	assert.equal(result.ok ? 0 : result.status, 409);
});

test("BLOCK_NOT_FOUND returned for stale ref", async () => {
	await writeDoc("notfound.md", "# Title\n");

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "notfound.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.replace", ref: "bdeadbeef", markdown: "New." }],
	});

	assert.ok(!result.ok);
	assert.equal(result.ok ? "" : result.code, "BLOCK_NOT_FOUND");
	assert.equal(result.ok ? 0 : result.status, 409);
});

test("FILE_NOT_FOUND for missing file", async () => {
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "does-not-exist.md",
		baseRevision: 0,
		by: "human",
		ops: [],
	});

	assert.ok(!result.ok);
	assert.equal(result.ok ? "" : result.code, "FILE_NOT_FOUND");
	assert.equal(result.ok ? 0 : result.status, 404);
});

test("AI insertAfter wraps text in proof-span", async () => {
	await writeDoc("ai-wrap.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "ai-wrap.md");
	const titleRef = snap!.blocks[0].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "ai-wrap.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "block.insertAfter",
			ref: titleRef,
			markdown: "AI wrote this content.",
			basis: "described",
			basisDetail: "user asked for it",
		}],
	});

	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
	const content = await readDoc("ai-wrap.md");
	assert.ok(content.includes("<proof-span"), `proof-span missing: ${content}`);
	assert.ok(content.includes('origin="ai"'), `origin missing: ${content}`);
	assert.ok(content.includes('by="ai:claude"'), `by missing: ${content}`);
	assert.ok(content.includes("AI wrote this content."), `content missing: ${content}`);
});

test("comment.add and comment.reply ops", async () => {
	await writeDoc("comment.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "comment.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "comment.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: paraRef, text: "Why this?" }],
	});
	assert.ok(addResult.ok);
	const commentId = addResult.ok ? addResult.snapshot.comments[0]?.id : null;
	assert.ok(commentId, "comment should have an id");

	const replyResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "comment.md",
		baseRevision: 1,
		by: "ai:claude",
		ops: [{ type: "comment.reply", commentId: commentId!, text: "Because of X." }],
	});
	assert.ok(replyResult.ok);
	const comment = replyResult.ok
		? replyResult.snapshot.comments.find((c) => c.id === commentId)
		: null;
	assert.ok(comment, "comment should be in snapshot");
	assert.equal(comment!.turns.length, 2, "should have 2 turns");
	assert.equal(comment!.turns[1].text, "Because of X.");
});


test("comment.add with lineAnchor stores line anchor on text files", async () => {
	await writeDoc("notes.txt", "Alpha\nBeta\nGamma\n");
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "notes.txt",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", lineAnchor: { lineStart: 2, lineEnd: 2, textHash: hashText("Beta") }, text: "Text comment." }],
	});
	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
	const comment = result.ok ? result.snapshot.comments[0] : null;
	assert.ok(comment);
	assert.equal(comment!.ref, undefined);
	assert.equal(comment!.lineAnchor?.lineStart, 2);
	assert.equal(comment!.lineAnchor?.textHash, hashText("Beta"));
	assert.equal(await readDoc("notes.txt"), "Alpha\nBeta\nGamma\n");
});

test("suggestion.add and suggestion.accept", async () => {
	await writeDoc("suggest.md", "# Title\n\nOriginal.\n");
	const snap = await readSnapshot(tmpRoot, "suggest.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "suggest.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Suggested replacement.",
			basis: "described",
		}],
	});
	assert.ok(addResult.ok, `add: ${JSON.stringify(addResult)}`);
	const sugId = addResult.ok ? addResult.snapshot.suggestions[0]?.id : null;
	assert.ok(sugId, "suggestion should have an id");

	const acceptResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "suggest.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: sugId! }],
	});
	assert.ok(acceptResult.ok, `accept: ${JSON.stringify(acceptResult)}`);
	// Suggestion should be gone from pending
	const pending = acceptResult.ok ? acceptResult.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending suggestions after accept");
	// File should have new content
	const content = await readDoc("suggest.md");
	assert.ok(content.includes("Suggested replacement."), `content: ${content}`);
});

test("suggestion.reject moves to archive", async () => {
	await writeDoc("reject.md", "# Title\n\nOriginal.\n");
	const snap = await readSnapshot(tmpRoot, "reject.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "reject.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Rejected suggestion.",
		}],
	});
	assert.ok(addResult.ok);
	const sugId = addResult.ok ? addResult.snapshot.suggestions[0]?.id : null;

	const rejectResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "reject.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "suggestion.reject", suggestionId: sugId! }],
	});
	assert.ok(rejectResult.ok);
	const pending = rejectResult.ok ? rejectResult.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending suggestions after reject");
	// File should NOT have been changed
	const content = await readDoc("reject.md");
	assert.ok(content.includes("Original."), `content unchanged: ${content}`);
});

test("events emitted for ops", async () => {
	await writeDoc("events.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "events.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "events.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "block.replace", ref: paraRef, markdown: "New." }],
	});

	assert.ok(result.ok);
	assert.ok(result.ok && result.emittedEvents.length > 0, "events should be emitted");
	assert.equal(result.ok ? result.emittedEvents[0].type : "", "block.replaced");
});

test("idempotency: same key returns cached response", async () => {
	await writeDoc("idem.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "idem.md");
	const paraRef = snap!.blocks[1].ref;

	const key = "test-idem-key-" + Date.now();
	const payload = {
		payloadHash: "abc",
		status: 200,
		body: JSON.stringify({ cached: true }),
	};
	idempotency.set(key, payload);

	const cached = idempotency.get(key);
	assert.ok(cached !== null, "cached entry should exist");
	assert.equal(cached!.body, JSON.stringify({ cached: true }));
	assert.equal(cached!.status, 200);

	// Different key should not be cached
	assert.equal(idempotency.get("other-key"), null);
});
