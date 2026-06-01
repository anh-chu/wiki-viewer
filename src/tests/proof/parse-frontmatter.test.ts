import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "../../lib/markdown/parse-frontmatter.js";

test("parses valid frontmatter and returns body", () => {
	const text = `---
title: Hello
status: draft
tags: [a, b, c]
---

# Body heading

Some text.`;
	const { data, body } = parseFrontmatter(text);
	assert.equal(data.title, "Hello");
	assert.equal(data.status, "draft");
	assert.deepEqual(data.tags, ["a", "b", "c"]);
	assert.ok(body.trimStart().startsWith("# Body heading"));
});

test("does not swallow body when a stray --- HR appears far below", () => {
	// Opening fence, but the content is markdown (heading), and the only later
	// `---` is a horizontal rule near the end. The parser must not treat the
	// whole document as frontmatter.
	const text = `---

## title: Collapsed heading not YAML

# Real Title

Intro paragraph.

---

**Next step:** trailing line.`;
	const { data, body } = parseFrontmatter(text);
	assert.deepEqual(data, {}, "no keys should be parsed");
	assert.ok(body.includes("# Real Title"), "body must retain the document");
	assert.ok(body.includes("Intro paragraph."), "body must not be swallowed");
});

test("returns empty data when block has no YAML keys", () => {
	const text = `---
just some prose
more prose
---

Body.`;
	const { data, body } = parseFrontmatter(text);
	assert.deepEqual(data, {});
	assert.equal(body, text, "entire text preserved as body");
});

test("no frontmatter fence returns text unchanged", () => {
	const text = `# Just a doc\n\nNo frontmatter here.`;
	const { data, body } = parseFrontmatter(text);
	assert.deepEqual(data, {});
	assert.equal(body, text);
});
