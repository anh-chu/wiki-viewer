import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../../lib/markdown/to-html.js";

// These tests guard the read-only viewer path (sanitize: true). The sanitize
// pipeline must actually run end to end: a missing HTML parser previously made
// it throw, which blanked the viewer body. Keep runtime coverage here.

test("sanitize path renders body, tables, and headings", async () => {
	const md = `## Section

<table><tbody><tr><td><p>Cell</p></td></tr></tbody></table>

Paragraph text.`;
	const html = await markdownToHtml(md, { sanitize: true });
	assert.ok(html.includes("<h2"), "heading should render");
	assert.ok(html.includes("<table"), "raw HTML table should survive");
	assert.ok(html.includes("Paragraph text."), "body should not be dropped");
});

test("sanitize path strips scripts, event handlers, and javascript: urls", async () => {
	const md = `<img src=x onerror="alert(1)">
<script>alert(2)</script>

[x](javascript:alert(3))`;
	const html = await markdownToHtml(md, { sanitize: true });
	assert.ok(!html.includes("onerror"), "onerror handler must be stripped");
	assert.ok(!html.includes("<script"), "script tag must be stripped");
	assert.ok(!html.includes("javascript:"), "javascript: url must be stripped");
});

test("sanitize path preserves the wiki-link contract", async () => {
	const html = await markdownToHtml("See [[my-page|Alias]] and [[other#sec]].", {
		sanitize: true,
	});
	assert.ok(html.includes('data-wiki-link="true"'), "wiki-link marker kept");
	assert.ok(html.includes('data-slug="my-page"'), "slug kept");
	assert.ok(html.includes('data-alias="Alias"'), "alias kept");
	assert.ok(html.includes('data-anchor="sec"'), "anchor kept");
});

test("unsanitized editor path leaves HTML untouched", async () => {
	const md = `<table><tbody><tr><td>x</td></tr></tbody></table>`;
	const html = await markdownToHtml(md);
	assert.ok(html.includes("<table"), "editor path keeps raw HTML");
});
