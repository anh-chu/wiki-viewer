import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, blockToMarkdown, blocksToMarkdown, blockType } from "../../lib/proof/blocks.js";

test("roundtrip preserves clean markdown", () => {
	const md = "The AI wrote this.";
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 1, "should parse as 1 block");
	assert.equal(blockToMarkdown(nodes[0]), md);
});

test("list with checkboxes detected as taskList", () => {
	const md = `- [x] Done\n- [ ] Todo`;
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 1);
	const { type } = blockType(nodes[0]);
	assert.equal(type, "taskList");
});

test("ordered list detected as orderedList", () => {
	const md = `1. First\n2. Second`;
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 1);
	const { type } = blockType(nodes[0]);
	assert.equal(type, "orderedList");
});

test("bullet list detected as bulletList", () => {
	const md = `- one\n- two`;
	const nodes = parseBlocks(md);
	const { type } = blockType(nodes[0]);
	assert.equal(type, "bulletList");
});

test("code block with lang preserved", () => {
	const md = "```typescript\nconst x = 1;\n```";
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 1);
	const { type, lang } = blockType(nodes[0]);
	assert.equal(type, "codeBlock");
	assert.equal(lang, "typescript");
	const out = blockToMarkdown(nodes[0]);
	assert.ok(out.includes("typescript"), `lang not preserved: ${out}`);
	assert.ok(out.includes("const x = 1;"), `code not preserved: ${out}`);
});

test("table preserved", () => {
	const md = "| A | B |\n|---|---|\n| 1 | 2 |";
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 1);
	const { type } = blockType(nodes[0]);
	assert.equal(type, "table");
	const out = blockToMarkdown(nodes[0]);
	assert.ok(out.includes("| A |"), `table not preserved: ${out}`);
});

test("blocksToMarkdown joins multiple blocks", () => {
	const md = "# Title\n\nSome text.\n\n- item1\n- item2";
	const nodes = parseBlocks(md);
	assert.equal(nodes.length, 3);
	const out = blocksToMarkdown(nodes);
	assert.ok(out.includes("# Title"), `heading missing: ${out}`);
	assert.ok(out.includes("Some text."), `paragraph missing: ${out}`);
	assert.ok(out.includes("item1"), `list missing: ${out}`);
});

test("heading block type detected", () => {
	const md = "## Section";
	const nodes = parseBlocks(md);
	const { type, level } = blockType(nodes[0]);
	assert.equal(type, "heading");
	assert.equal(level, 2);
});

test("hr block type detected", () => {
	const md = "---";
	const nodes = parseBlocks(md);
	const { type } = blockType(nodes[0]);
	assert.equal(type, "hr");
});
