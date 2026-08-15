import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../../lib/markdown/to-html.js";

// Post-deletion contract: old documents may still contain <proof-span> tags.
// The renderer's job is tolerate-on-read — content survives, no crash, no
// garbled output. The tag may persist as an inert wrapper or be stripped; either
// is acceptable. What must be true: the wrapped text reaches the reader.
test("legacy <proof-span> content survives rendering (tolerate-on-read)", async () => {
	const md =
		'# Test\n\n<proof-span id="p0123" origin="ai" basis="old instruction">Wrapped paragraph.</proof-span>\n\nClean paragraph.';
	const html = await markdownToHtml(md, { sanitize: true });
	assert.ok(html.includes("Wrapped paragraph."), "content preserved");
	assert.ok(html.includes("Clean paragraph."), "sibling content preserved");
	assert.ok(
		!html.includes('origin="ai"') && !html.includes('basis="old'),
		"provenance attributes stripped by sanitizer",
	);
});
