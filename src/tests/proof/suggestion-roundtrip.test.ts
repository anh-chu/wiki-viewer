/**
 * A tracked change mark must survive the markdown round-trip.
 *
 * This is the property that makes tracked changes trustworthy. A tracked change is stored
 * as a ProseMirror mark, and the `.md` file is the source of truth — so the mark
 * has to survive being written to markdown and read back. If it does not, the
 * tracked change is silently converted into an applied edit on the next save: the
 * reviewer believes they are looking at a proposal when they are looking at a
 * fait accompli.
 *
 * Two separate places could drop it, and both did at some point:
 *
 *   1. Turndown (markdown serialization). Markdown has no syntax for "suggested
 *      change", so without an explicit rule the tag is discarded and the text kept.
 *   2. rehype-sanitize (html rendering). The default schema strips attributes, and
 *      it uses camelCase hast names, so `data-id` is written as `dataId`. Without
 *      that entry the id is stripped and the mark no longer parses.
 *
 * Both are asserted below, because the failure mode of each is identical from the
 * outside — the tracked change is gone — and a test that only covered one would pass
 * while the other was broken.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { markdownToHtml } from "@/lib/markdown/to-html";

const SUGGESTED =
	'<p>Keep this. <ins data-id="7">Added text.</ins> <del data-id="8">Removed text.</del></p>';

test("serialization keeps suggested insertions and deletions", async () => {
	const md = htmlToMarkdown(SUGGESTED);

	assert.match(
		md,
		/<ins data-id="7">Added text\.<\/ins>/,
		"an insertion must serialize with its tracked change id, not as plain text",
	);
	assert.match(
		md,
		/<del data-id="8">Removed text\.<\/del>/,
		"a deletion must serialize with its tracked change id",
	);
});

test("the tags survive the sanitizer, id included", async () => {
	// `sanitize: true` is the viewer path; `false` is the editor path. A tracked change
	// has to render in both, so both are checked rather than the one that happens
	// to be convenient.
	for (const sanitize of [false, true]) {
		const html = await markdownToHtml(
			'<ins data-id="7">Added text.</ins> <del data-id="8">Removed text.</del>',
			{ sanitize },
		);

		assert.match(
			html,
			/<ins[^>]*data-id="7"/,
			`sanitize=${sanitize}: the insertion id must survive, or the mark cannot parse`,
		);
		assert.match(
			html,
			/<del[^>]*data-id="8"/,
			`sanitize=${sanitize}: the deletion id must survive`,
		);
	}
});

test("CONTROL: without the rules the tracked change is destroyed", async () => {
	// The negative control. If the two assertions above are the whole test, they
	// could pass because Turndown happened to preserve the tags for an unrelated
	// reason, and a future change that broke the rules would go unnoticed.
	//
	// This pins the actual failure mode: default Turndown keeps the text and drops
	// the tag, so a tracked change reads as an applied edit.
	const { default: TurndownService } = await import("turndown");
	const bare = new TurndownService();

	const destroyed = bare.turndown(SUGGESTED);

	assert.doesNotMatch(
		destroyed,
		/<ins|<del/,
		"the control must reproduce the loss, or the rules are not what is preserving them",
	);
	assert.match(
		destroyed,
		/Added text\./,
		"and the text survives as a plain edit, which is the silent corruption",
	);
});

test("a tracked change round-trips byte-identically through markdown", async () => {
	// End to end, the property that matters: what was written is what comes back.
	const md = htmlToMarkdown(SUGGESTED);
	const md2 = htmlToMarkdown(await markdownToHtml(md, { sanitize: false }));

	assert.equal(md2, md, "a second round-trip must not change the file further");
});