/**
 * A modification mark must survive a save and reload with all of its state.
 *
 * This is the mark that carries the most information and had the least coverage.
 * The vendored spec declares five attributes, and the Tiptap wrapper initially
 * projected only `id` — so `attrName`, `previousValue` and `newValue` were dropped
 * on the way into the document, and `data-mod-type` / `data-mod-prev-val` /
 * `data-mod-new-val` were never allowed out of the sanitizer or through Turndown.
 *
 * The consequences are not cosmetic:
 *
 *   - `attrName` is what `commands.js` reads to know which node attribute to
 *     restore when a modification is rejected. Without it, rejecting an attribute
 *     change cannot put the old value back.
 *   - Losing `data-type="modification"` un-marks the modification entirely: it is
 *     also the parse selector, so the next reload reads the text as ordinary
 *     content and the pending change silently becomes an applied one.
 *
 * Every one of these failed silently — the document looked right until it was
 * reloaded — which is why the assertions here run the real conversion pipeline
 * rather than comparing against a hand-built string.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml } from "../../lib/markdown/to-html.js";
import { htmlToMarkdown } from "../../lib/markdown/to-markdown.js";

/** Round-trip markdown through the real pipeline, the way opening a file does. */
async function roundTrip(md: string): Promise<string> {
	return htmlToMarkdown(await markdownToHtml(md));
}

test("an inline modification keeps every attribute across a round-trip", async () => {
	const md =
		'Before <span data-type="modification" data-id="7" data-mod-type="text" ' +
		'data-mod-prev-val="old" data-mod-new-val="new">changed</span> after.';

	const back = await roundTrip(md);

	// The wrapper itself: this is the parse selector, so losing it un-marks the
	// change on the next load and the edit applies itself.
	assert.match(back, /data-type="modification"/, "the modification wrapper survives");
	assert.match(back, /data-id="7"/, "and its suggestion id");

	// The state reject needs. `data-mod-prev-val` is the value restored when a
	// node-attribute change is rejected.
	assert.match(back, /data-mod-type="text"/, "the change kind survives");
	assert.match(back, /data-mod-prev-val="old"/, "the previous value survives");
	assert.match(back, /data-mod-new-val="new"/, "and the new value");

	// The surrounding text must not be swallowed by the wrapper.
	assert.match(back, /^Before /, "text before the modification is intact");
	assert.match(back, / after\.$/, "text after it is intact");
});

test("a block-level modification survives as a div", async () => {
	// A modification wrapping a whole block serialises as `<div>`, not `<span>`.
	// Flattening both forms to one element loses the block boundary and the
	// modification comes back wrapping inline content that was never inline.
	const md =
		'<div data-type="modification" data-id="9" data-mod-type="text" ' +
		'data-mod-prev-val="whole old block">whole new block</div>';

	const back = await roundTrip(md);

	assert.match(back, /data-type="modification"/, "the wrapper survives");
	assert.match(back, /data-id="9"/, "with its id");
	assert.match(back, /data-mod-prev-val="whole old block"/, "and the value it replaced");
});

test("a plain span is not mistaken for a modification", async () => {
	// The filter keys on `data-type="modification"`, so an ordinary styled span
	// must pass through untouched rather than being re-serialised as a change.
	const back = await roundTrip('<span class="note">just styled</span>');
	assert.doesNotMatch(back, /data-type="modification"/, "no wrapper is invented");
});