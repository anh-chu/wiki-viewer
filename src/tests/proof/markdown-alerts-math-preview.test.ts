import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../../lib/markdown/to-html.js";
import { htmlToMarkdown } from "../../lib/markdown/to-markdown.js";

// GitHub alerts, $/$$ maths and ```html preview fences: rendered into the
// editor's nodes, kept by the sanitizer, and written back to the same Markdown.

test("GitHub alerts become callout nodes, one kind each", async () => {
	for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
		const html = await markdownToHtml(`> [!${kind}]\n> Body text.`, { sanitize: true });
		assert.ok(html.includes('data-callout="true"'), `${kind}: callout marker`);
		assert.ok(html.includes(`data-callout-type="${kind.toLowerCase()}"`), `${kind}: kind kept`);
		assert.ok(html.includes("Body text."), `${kind}: body kept`);
		assert.ok(!html.includes(`[!${kind}]`), `${kind}: marker removed from text`);
	}
});

test("a plain blockquote stays a blockquote", async () => {
	const html = await markdownToHtml("> Just a quote.", { sanitize: true });
	assert.ok(html.includes("<blockquote>"));
	assert.ok(!html.includes("data-callout"));
});

test("inline and display maths become Mathematics nodes", async () => {
	const html = await markdownToHtml("Inline $a^2+b^2=c^2$ here.\n\n$$\n\\int_0^1 x\\,dx\n$$", {
		sanitize: true,
	});
	assert.ok(html.includes('data-type="inline-math"'), "inline math node");
	assert.ok(html.includes('data-latex="a^2+b^2=c^2"'), "inline latex kept");
	assert.ok(html.includes('data-type="block-math"'), "block math node");
	assert.ok(html.includes("\\int_0^1"), "block latex kept");
});

test("an html preview fence becomes a sandboxed preview node; a plain html fence stays code", async () => {
	const md = "```html preview\n<p id=x>hi</p><script>x.textContent='ok'</script>\n```\n\n```html\n<p>code</p>\n```";
	const html = await markdownToHtml(md, { sanitize: true });
	assert.ok(html.includes('data-html-preview="true"'), "preview node");
	assert.ok(html.includes("data-srcdoc="), "source kept for the frame");
	// The source lives (escaped) in data-srcdoc; nothing outside it may be a live script.
	const outside = html.replace(/data-srcdoc="[^"]*"/g, "");
	assert.ok(!/<script/i.test(outside), "no live script in the page itself");
	assert.ok(html.includes("language-html"), "plain html fence is still a code block");
});

test("callouts, maths and previews round-trip back to Markdown", async () => {
	const md = [
		"> [!WARNING]",
		"> Mind the gap.",
		"",
		"Inline $x^2$ and:",
		"",
		"$$",
		"E = mc^2",
		"$$",
		"",
		"```html preview",
		"<b>live</b>",
		"```",
	].join("\n");
	const back = htmlToMarkdown(await markdownToHtml(md));
	assert.ok(back.includes("> [!WARNING]"), "alert kind written back");
	assert.ok(back.includes("> Mind the gap."), "alert body written back");
	assert.ok(back.includes("$x^2$"), "inline maths written back");
	assert.ok(/\$\$\nE = mc\^2\n\$\$/.test(back), "display maths written back");
	assert.ok(back.includes("```html preview\n<b>live</b>\n```"), "preview fence written back");
});
