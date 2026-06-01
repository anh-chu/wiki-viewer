import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { setRootDir } from "../../lib/root-dir.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-comment-test-"));
	setRootDir(tmpRoot);
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

test("comment.add — sidecar has comment with one turn", async () => {
	await writeDoc("cadd.md", "# Title\n\nA paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "cadd.md");
	assert.ok(snap !== null);
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "cadd.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: paraRef, text: "First comment." }],
	});

	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
	assert.equal(result.ok ? result.snapshot.comments.length : -1, 1);
	const c = result.ok ? result.snapshot.comments[0] : null;
	assert.ok(c !== null);
	assert.equal(c!.resolved, false);
	assert.equal(c!.ref, paraRef);
	assert.equal(c!.turns.length, 1);
	assert.equal(c!.turns[0].text, "First comment.");
	assert.equal(c!.turns[0].by, "human");
});

test("comment.reply — existing comment gains second turn", async () => {
	await writeDoc("creply.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "creply.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "creply.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: paraRef, text: "Why?" }],
	});
	assert.ok(addResult.ok);
	const commentId = addResult.ok ? addResult.snapshot.comments[0]?.id : null;
	assert.ok(commentId);

	const replyResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "creply.md",
		baseRevision: 1,
		by: "ai:claude",
		ops: [{ type: "comment.reply", commentId: commentId!, text: "Because reasons." }],
	});
	assert.ok(replyResult.ok, `expected ok: ${JSON.stringify(replyResult)}`);
	const c = replyResult.ok
		? replyResult.snapshot.comments.find((x) => x.id === commentId)
		: null;
	assert.ok(c, "comment should be in snapshot");
	assert.equal(c!.turns.length, 2);
	assert.equal(c!.turns[1].text, "Because reasons.");
	assert.equal(c!.turns[1].by, "ai:claude");
});

test("comment.resolve — resolved=true + event emitted", async () => {
	await writeDoc("cresolve.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "cresolve.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "cresolve.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: paraRef, text: "Open thread." }],
	});
	assert.ok(addResult.ok);
	const commentId = addResult.ok ? addResult.snapshot.comments[0]?.id : null;
	assert.ok(commentId);

	const resolveResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "cresolve.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "comment.resolve", commentId: commentId! }],
	});
	assert.ok(resolveResult.ok, `expected ok: ${JSON.stringify(resolveResult)}`);
	const c = resolveResult.ok
		? resolveResult.snapshot.comments.find((x) => x.id === commentId)
		: null;
	assert.ok(c, "comment still present in snapshot");
	assert.equal(c!.resolved, true);
	// event emitted
	const evt = resolveResult.ok
		? resolveResult.emittedEvents.find((e) => e.type === "comment.resolved")
		: null;
	assert.ok(evt, "comment.resolved event should be emitted");
	assert.equal((evt as unknown as { commentId: string } | null)?.commentId, commentId);
});

test("comment.reopen — resolved=false + event emitted", async () => {
	await writeDoc("creopen.md", "# Title\n\nParagraph.\n");
	const snap = await readSnapshot(tmpRoot, "creopen.md");
	const paraRef = snap!.blocks[1].ref;

	// add then resolve
	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "creopen.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: paraRef, text: "Thread." }],
	});
	assert.ok(addResult.ok);
	const commentId = addResult.ok ? addResult.snapshot.comments[0]?.id : null;
	assert.ok(commentId);

	const resolveResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "creopen.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "comment.resolve", commentId: commentId! }],
	});
	assert.ok(resolveResult.ok);

	const reopenResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "creopen.md",
		baseRevision: 2,
		by: "human",
		ops: [{ type: "comment.reopen", commentId: commentId! }],
	});
	assert.ok(reopenResult.ok, `expected ok: ${JSON.stringify(reopenResult)}`);
	const c = reopenResult.ok
		? reopenResult.snapshot.comments.find((x) => x.id === commentId)
		: null;
	assert.ok(c);
	assert.equal(c!.resolved, false);
	// event emitted
	const evt = reopenResult.ok
		? reopenResult.emittedEvents.find((e) => e.type === "comment.reopened")
		: null;
	assert.ok(evt, "comment.reopened event should be emitted");
});

test("comment.reply to nonexistent commentId → 409 COMMENT_NOT_FOUND", async () => {
	await writeDoc("cnotfound.md", "# Title\n\nParagraph.\n");
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "cnotfound.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.reply", commentId: "cdeadbeef", text: "Ghost reply." }],
	});
	assert.ok(!result.ok);
	assert.equal(result.ok ? "" : result.code, "COMMENT_NOT_FOUND");
	assert.equal(result.ok ? 0 : result.status, 409);
});
