import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-edit-delete-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), "# Title\n\nOriginal paragraph.\n", "utf-8");
}

async function addComment(name: string, kind?: "instruction"): Promise<string> {
	const snapshot = await readSnapshot(tmpRoot, name);
	assert.ok(snapshot);
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref: snapshot.blocks[1].ref, text: "Original comment.", ...(kind ? { kind } : {}) }],
	});
	assert.ok(result.ok, `comment.add failed: ${JSON.stringify(result)}`);
	const id = result.snapshot.comments[0]?.id;
	assert.ok(id);
	return id;
}

async function addSuggestion(name: string, markdown = "Proposed replacement."): Promise<string> {
	const snapshot = await readSnapshot(tmpRoot, name);
	assert.ok(snapshot);
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref: snapshot.blocks[1].ref, kind: "replace", markdown }],
	});
	assert.ok(result.ok, `suggestion.add failed: ${JSON.stringify(result)}`);
	const id = result.snapshot.suggestions[0]?.id;
	assert.ok(id);
	return id;
}

function assertEvent(event: unknown, type: string, by: string, idKey: string, id: string): void {
	assert.ok(event, `${type} event should be emitted`);
	const value = event as Record<string, unknown>;
	assert.equal(value.type, type);
	assert.equal(value.by, by);
	assert.equal(value[idKey], id);
	assert.equal(typeof value.at, "string");
	assert.ok((value.at as string).length > 0);
}

test("comment.edit replaces only the first turn, keeps replies, and emits standard event", async () => {
	const name = "comment-edit.md";
	await writeDoc(name);
	const commentId = await addComment(name);
	const reply = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "comment.reply", commentId, text: "Reply remains." }],
	});
	assert.ok(reply.ok);

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.edit", commentId, text: "Edited first turn." }],
	});
	assert.ok(result.ok, `comment.edit failed: ${JSON.stringify(result)}`);
	const comment = result.snapshot.comments.find((item) => item.id === commentId);
	assert.ok(comment);
	assert.equal(comment.turns.length, 2);
	assert.equal(comment.turns[0].text, "Edited first turn.");
	assert.equal(comment.turns[1].text, "Reply remains.");
	assertEvent(result.emittedEvents.find((event) => event.type === "comment.edited"), "comment.edited", "human", "commentId", commentId);
});

test("comment.edit succeeds for a resolved comment", async () => {
	const name = "comment-edit-resolved.md";
	await writeDoc(name);
	const commentId = await addComment(name);
	const resolve = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.resolve", commentId }] });
	assert.ok(resolve.ok);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.edit", commentId, text: "Edited after resolve." }] });
	assert.ok(result.ok, `resolved comment.edit failed: ${JSON.stringify(result)}`);
	assert.equal(result.snapshot.comments[0]?.turns[0]?.text, "Edited after resolve.");
});

test("comment.edit unknown id returns 409 COMMENT_NOT_FOUND", async () => {
	const name = "comment-edit-missing.md";
	await writeDoc(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.edit", commentId: "cdeadbeef", text: "Ghost." }] });
	assert.ok(!result.ok);
	assert.equal(result.code, "COMMENT_NOT_FOUND");
	assert.equal(result.status, 409);
});

test("comment.delete removes a comment and emits standard event", async () => {
	const name = "comment-delete.md";
	await writeDoc(name);
	const commentId = await addComment(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.delete", commentId }] });
	assert.ok(result.ok, `comment.delete failed: ${JSON.stringify(result)}`);
	assert.equal(result.snapshot.comments.length, 0);
	assertEvent(result.emittedEvents.find((event) => event.type === "comment.deleted"), "comment.deleted", "human", "commentId", commentId);
});

test("comment.delete works for an instruction-kind comment", async () => {
	const name = "comment-delete-instruction.md";
	await writeDoc(name);
	const commentId = await addComment(name, "instruction");
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.delete", commentId }] });
	assert.ok(result.ok);
	assert.equal(result.snapshot.comments.length, 0);
});

test("comment.delete unknown id returns 409 COMMENT_NOT_FOUND", async () => {
	const name = "comment-delete-missing.md";
	await writeDoc(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "comment.delete", commentId: "cdeadbeef" }] });
	assert.ok(!result.ok);
	assert.equal(result.code, "COMMENT_NOT_FOUND");
	assert.equal(result.status, 409);
});

test("suggestion.edit updates pending markdown and kind, and emits standard event", async () => {
	const name = "suggestion-edit.md";
	await writeDoc(name);
	const suggestionId = await addSuggestion(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.edit", suggestionId, markdown: "Edited insertion.", kind: "insertAfter" }] });
	assert.ok(result.ok, `suggestion.edit failed: ${JSON.stringify(result)}`);
	const suggestion = result.snapshot.suggestions.find((item) => item.id === suggestionId);
	assert.ok(suggestion);
	assert.equal(suggestion.markdown, "Edited insertion.");
	assert.equal(suggestion.kind, "insertAfter");
	assertEvent(result.emittedEvents.find((event) => event.type === "suggestion.edited"), "suggestion.edited", "human", "suggestionId", suggestionId);
});

test("suggestion.edit unknown id returns 409 SUGGESTION_NOT_FOUND", async () => {
	const name = "suggestion-edit-missing.md";
	await writeDoc(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.edit", suggestionId: "sdeadbeef", markdown: "Ghost." }] });
	assert.ok(!result.ok);
	assert.equal(result.code, "SUGGESTION_NOT_FOUND");
	assert.equal(result.status, 409);
});

for (const settledStatus of ["rejected", "accepted"] as const) {
	test(`suggestion.edit ${settledStatus} suggestion returns 409 SUGGESTION_NOT_FOUND`, async () => {
		const name = `suggestion-edit-${settledStatus}.md`;
		await writeDoc(name);
		const suggestionId = await addSuggestion(name);
		const settled = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: settledStatus === "accepted" ? "suggestion.accept" : "suggestion.reject", suggestionId }] });
		assert.ok(settled.ok);
		const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: settled.ok ? settled.snapshot.revision : 0, by: "human", ops: [{ type: "suggestion.edit", suggestionId, markdown: "Too late." }] });
		assert.ok(!result.ok);
		assert.equal(result.code, "SUGGESTION_NOT_FOUND");
		assert.equal(result.status, 409);
	});
}

test("suggestion.delete removes a pending suggestion and emits standard event", async () => {
	const name = "suggestion-delete.md";
	await writeDoc(name);
	const suggestionId = await addSuggestion(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.delete", suggestionId }] });
	assert.ok(result.ok, `suggestion.delete failed: ${JSON.stringify(result)}`);
	assert.equal(result.snapshot.suggestions.length, 0);
	assertEvent(result.emittedEvents.find((event) => event.type === "suggestion.deleted"), "suggestion.deleted", "human", "suggestionId", suggestionId);
});

test("suggestion.delete unknown id returns 409 SUGGESTION_NOT_FOUND", async () => {
	const name = "suggestion-delete-missing.md";
	await writeDoc(name);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.delete", suggestionId: "sdeadbeef" }] });
	assert.ok(!result.ok);
	assert.equal(result.code, "SUGGESTION_NOT_FOUND");
	assert.equal(result.status, 409);
});

test("suggestion.delete rejects settled suggestions with 409 SUGGESTION_NOT_FOUND", async () => {
	const name = "suggestion-delete-settled.md";
	await writeDoc(name);
	const suggestionId = await addSuggestion(name);
	const settled = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.reject", suggestionId }] });
	assert.ok(settled.ok);
	const result = await applyOps({ rootDir: tmpRoot, mdPath: name, baseRevision: 0, by: "human", ops: [{ type: "suggestion.delete", suggestionId }] });
	assert.ok(!result.ok);
	assert.equal(result.code, "SUGGESTION_NOT_FOUND");
	assert.equal(result.status, 409);
});
