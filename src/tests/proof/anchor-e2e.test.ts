import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";

/**
 * End-to-end through the real op applier: the failure reported live, and its fix.
 *
 * The report was "my suggestions suddenly got reset after some event", with the console
 * showing annotated blocks that had no rendered element. Refs are content-derived, so
 * the first edit that changed a block's text killed every annotation on it. These drive
 * the actual write and read paths rather than the resolver in isolation, because the
 * defect lived in the wiring between them.
 */

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-anchor-e2e-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

async function seedComment(name: string, content: string, selectedText: string) {
	await writeDoc(name, content);
	const snap = await readSnapshot(tmpRoot, name);
	assert.ok(snap);
	const block = snap.blocks.find((b) => b.markdown.includes(selectedText));
	assert.ok(block, `no block contains ${selectedText}`);
	const start = block.markdown.indexOf(selectedText);
	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		ops: [
			{
				type: "comment.add",
				ref: block.ref,
				text: "on these words",
				textAnchor: { start, end: start + selectedText.length, selectedText },
			} as never,
		],
		by: "human",
		baseRevision: snap.revision,
	});
	assert.equal(result.ok, true, JSON.stringify(result));
	return { blockRef: block.ref, result };
}

describe("an anchor survives the edit that used to destroy it", () => {
	test("comment.add mints an anchor, and the snapshot resolves it", async () => {
		const { result } = await seedComment("e2e1.md", "# T\n\nAlpha paragraph here.\n", "paragraph");
		const snap = result.snapshot!;
		const comment = snap.comments[0];
		assert.ok(comment, "the comment was stored");
		assert.ok(comment.anchorId, "and it carries a durable anchor");
		assert.ok(snap.commentViews?.[comment.id], "the read model resolves it");
		assert.equal(snap.commentViews![comment.id].status, "exact");
		assert.equal(snap.commentViews![comment.id].length, "paragraph".length);
	});

	test("REGRESSION: editing the annotated block keeps the comment resolvable", async () => {
		// This is the reported failure. The block's text changes, so its ref changes, and
		// before anchors every annotation on it became unplaceable.
		const { blockRef, result } = await seedComment(
			"e2e2.md",
			"# T\n\nAlpha paragraph here.\n",
			"paragraph",
		);
		const first = result.snapshot!;
		const comment = first.comments[0];
		const oldView = first.commentViews![comment.id];

		// Rewrite the block: new text, therefore a new ref.
		const edited = await applyOps({
			rootDir: tmpRoot,
			mdPath: "e2e2.md",
			ops: [{ type: "block.replace", ref: blockRef, markdown: "Alpha paragraph here. MORE" }],
			by: "human",
			baseRevision: first.revision,
		});
		assert.equal(edited.ok, true, JSON.stringify(edited));
		const after = edited.snapshot!;
		const newRef = after.blocks.find((b) => b.markdown.includes("MORE"))!.ref;
		assert.notEqual(newRef, blockRef, "the ref really did change");

		const view = after.commentViews![comment.id];
		assert.ok(view, "the comment is still in the read model");
		assert.ok(view.ref, "and resolved to a real block, not orphaned");
		assert.equal(view.ref, newRef, "it follows the block to its new ref");
		// The words it was about are unchanged, so it stays exact even though the ref moved.
		assert.ok(["exact", "moved"].includes(view.status), `status was ${view.status}`);
		assert.equal(view.length, "paragraph".length);
		assert.equal(oldView.length, view.length, "the quote is not corrupted by the edit");
	});

	test("a block-granular comment follows its block across a rewrite", async () => {
		// No selection: the comment covers the block. Its anchor must track the block.
		await writeDoc("e2e3.md", "# T\n\nBeta paragraph here.\n");
		const snap = await readSnapshot(tmpRoot, "e2e3.md");
		assert.ok(snap);
		const block = snap.blocks.find((b) => b.markdown.includes("Beta"))!;
		const added = await applyOps({
			rootDir: tmpRoot,
			mdPath: "e2e3.md",
			ops: [{ type: "comment.add", ref: block.ref, text: "whole block" } as never],
			by: "human",
			baseRevision: snap.revision,
		});
		const comment = added.snapshot!.comments[0];
		assert.ok(comment.anchorId, "a block comment is anchored too");

		const edited = await applyOps({
			rootDir: tmpRoot,
			mdPath: "e2e3.md",
			ops: [{ type: "block.replace", ref: block.ref, markdown: "Rewritten entirely." }],
			by: "human",
			baseRevision: added.snapshot!.revision,
		});
		const view = edited.snapshot!.commentViews![comment.id];
		assert.ok(view.ref, "still placed after the whole block was rewritten");
		assert.ok(["moved", "ambiguous"].includes(view.status), `status was ${view.status}`);
	});

	test("deleting the annotated block reports it lost, and does not drop it", async () => {
		const { blockRef, result } = await seedComment(
			"e2e4.md",
			"# T\n\nGamma paragraph here.\n",
			"paragraph",
		);
		const comment = result.snapshot!.comments[0];
		const deleted = await applyOps({
			rootDir: tmpRoot,
			mdPath: "e2e4.md",
			ops: [{ type: "block.delete", ref: blockRef }],
			by: "human",
			baseRevision: result.snapshot!.revision,
		});
		const snap = deleted.snapshot!;
		const stillThere = snap.comments.find((c) => c.id === comment.id);
		assert.ok(stillThere, "the comment is not silently deleted");
		const view = snap.commentViews![comment.id];
		assert.equal(view.status, "lost", "and it is reported as lost");
		assert.equal(view.ref, null, "with no invented placement");
	});

});
