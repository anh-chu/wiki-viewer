import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks } from "../../lib/proof/blocks.js";
import { assignRefs, resolveRef } from "../../lib/proof/block-refs.js";
import { emptySidecar } from "../../lib/proof/sidecar.js";
import type { Sidecar } from "../../lib/proof/types.js";

function makeSidecar(refMap: Sidecar["refMap"]): Sidecar {
	return { ...emptySidecar("test.md"), refMap };
}

test("first parse assigns refs deterministically", () => {
	const md = "# Title\n\nParagraph.\n";
	const nodes = parseBlocks(md);
	const { blocks } = assignRefs(nodes, null);

	const { blocks: blocks2 } = assignRefs(nodes, null);
	assert.equal(blocks[0].ref, blocks2[0].ref, "heading ref should be deterministic");
	assert.equal(blocks[1].ref, blocks2[1].ref, "paragraph ref should be deterministic");
});

test("re-parse with same content reuses refs", () => {
	const md = "# Title\n\nParagraph.\n";
	const nodes = parseBlocks(md);
	const { blocks: first, newRefMap } = assignRefs(nodes, null);

	const sidecar = makeSidecar(newRefMap);
	const { blocks: second } = assignRefs(nodes, sidecar);

	assert.equal(first[0].ref, second[0].ref, "heading ref should be reused");
	assert.equal(first[1].ref, second[1].ref, "paragraph ref should be reused");
});

test("edit one block, others keep refs", () => {
	const md = "# Title\n\nOriginal paragraph.\n\n## Section\n";
	const nodes = parseBlocks(md);
	const { blocks: original, newRefMap } = assignRefs(nodes, null);

	// Edit the paragraph
	const md2 = "# Title\n\nEdited paragraph.\n\n## Section\n";
	const nodes2 = parseBlocks(md2);
	const sidecar = makeSidecar(newRefMap);
	const { blocks: updated } = assignRefs(nodes2, sidecar);

	assert.equal(updated[0].ref, original[0].ref, "heading ref should be preserved");
	assert.equal(updated[2].ref, original[2].ref, "second heading ref should be preserved");
	// Middle block changed, so it gets a new ref
	assert.notEqual(updated[1].ref, original[1].ref, "edited block should get new ref");
});

test("insert a block in middle, others keep refs", () => {
	const md = "# Title\n\nParagraph.\n";
	const nodes = parseBlocks(md);
	const { blocks: original, newRefMap } = assignRefs(nodes, null);

	// Insert a new block in the middle
	const md2 = "# Title\n\nNew block.\n\nParagraph.\n";
	const nodes2 = parseBlocks(md2);
	const sidecar = makeSidecar(newRefMap);
	const { blocks: updated } = assignRefs(nodes2, sidecar);

	assert.equal(updated[0].ref, original[0].ref, "heading ref preserved after insert");
	assert.equal(updated[2].ref, original[1].ref, "paragraph ref preserved after insert");
	assert.notEqual(updated[1].ref, original[0].ref, "new block has distinct ref");
	assert.notEqual(updated[1].ref, original[1].ref, "new block has distinct ref");
});

test("aliases populated after replace", () => {
	const md = "# Title\n\nOriginal.\n";
	const nodes = parseBlocks(md);
	const { blocks: original, newRefMap } = assignRefs(nodes, null);

	const md2 = "# Title\n\nReplaced.\n";
	const nodes2 = parseBlocks(md2);
	const sidecar = makeSidecar(newRefMap);
	const { blocks: updated, newRefMap: newMap } = assignRefs(nodes2, sidecar);

	// Old ref for the paragraph should not appear in new refMap
	const oldRef = original[1].ref;
	const newRef = updated[1].ref;
	assert.ok(oldRef !== newRef, "replaced block should have different ref");
	assert.ok(!(oldRef in newMap), "old ref should not be in new refMap");
});

test("resolveRef resolves via aliases", () => {
	const md = "Paragraph.\n";
	const nodes = parseBlocks(md);
	const { blocks, newRefMap } = assignRefs(nodes, null);
	const oldRef = blocks[0].ref;

	// Simulate a replacement: new content
	const md2 = "Replaced.\n";
	const nodes2 = parseBlocks(md2);
	const sidecarWithAlias: Sidecar = {
		...makeSidecar(newRefMap),
		refAliases: { [oldRef]: "bnewref" },
	};

	const current = new Set(["bnewref"]);
	const resolved = resolveRef(sidecarWithAlias, oldRef, current);
	assert.equal(resolved, "bnewref", "should resolve via alias");
});

test("resolveRef returns null for unknown ref", () => {
	const sidecar = makeSidecar({});
	const resolved = resolveRef(sidecar, "bdeadbeef", new Set(["babc123"]));
	assert.equal(resolved, null);
});
