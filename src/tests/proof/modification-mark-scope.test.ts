/**
 * What a pending modification is allowed to do to the file, and why the strip is blunt.
 *
 * A modification mark means "the formatting of this text changed while suggesting".
 * Stripping it has two properties to satisfy, and they pull in opposite directions:
 *
 *   - The canonical `.md` must not change while a suggestion is pending, so the
 *     proposed formatting (`**bold**`) must not reach Turndown.
 *   - Formatting that was already there must survive, so a modification over an
 *     existing `<code>` span should not delete it.
 *
 * The mark records the NEW formatting without recording the old one, so the HTML
 * alone cannot say which tags are the proposal. Two implementations were tried and
 * each satisfied one property:
 *
 *   1. Strip all formatting inside the wrapper -> byte-identity held, but
 *      `a <code>b</code> c` became `a b c`, deleting formatting the user already had.
 *   2. Unwrap and keep the formatting -> the user's formatting survived, but
 *      `<strong>fox</strong>` became `**fox**` in the file, so a pending suggestion
 *      changed the canonical document.
 *
 * The shipped compromise strips inside the wrapper only: the file is protected, which
 * is the contract this module exists for, and the cost is bounded because the mark is
 * never created by the editor — see the CONTROL below. It is a defensive path for
 * pasted or agent-supplied HTML.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { stripTrackChangesFromHTML } from "@/lib/proof/track-changes-strip";

const BEHAVIOR = readFileSync(
	new URL("../../components/editor/extensions/track-changes-behavior.ts", import.meta.url),
	"utf8",
);
const TRACK_CHANGES = readFileSync(
	new URL("../../components/editor/extensions/track-changes.ts", import.meta.url),
	"utf8",
);

describe("a pending modification protects the file", () => {
	test("the proposed formatting does not reach the markdown", () => {
		// The property that wins, because a suggestion changing the canonical file is
		// the failure this whole module exists to prevent.
		const out = stripTrackChangesFromHTML(
			'<p>The <span data-tracked="modification"><strong>fox</strong></span>.</p>',
		);
		assert.doesNotMatch(out, /<strong>/, "the proposal must not survive");
		assert.match(out, /fox/, "but the word stays");
	});

	test("formatting outside the wrapper is untouched", () => {
		// The part attempt 1 got wrong: tags merely near the modification were also
		// being removed.
		const out = stripTrackChangesFromHTML(
			'<p><code>before</code> <span data-tracked="modification"><strong>mid</strong></span> <em>after</em></p>',
		);
		assert.match(out, /<code>before<\/code>/, "formatting before the wrapper survives");
		assert.match(out, /<em>after<\/em>/, "and after it");
		assert.doesNotMatch(out, /<strong>/, "while the proposal still goes");
	});

	test("no tracking markup leaks in any case", () => {
		const out = stripTrackChangesFromHTML(
			'<p>a <span data-tracked="modification"><code>b</code></span> c</p>',
		);
		assert.doesNotMatch(out, /data-tracked/);
	});

	test("a link inside the wrapper keeps its destination", () => {
		// A link's href is content, not formatting. Stripping the anchor deleted the
		// destination and left the words: `[the docs](https://x.test)` became
		// `the docs`. Nothing about a formatting suggestion says where a link points.
		const out = stripTrackChangesFromHTML(
			'<p>see <span data-tracked="modification"><a href="https://x.test">the docs</a></span> now</p>',
		);
		assert.match(out, /href="https:\/\/x\.test"/, "the destination must survive");
		assert.match(out, /the docs/, "and the text");
		assert.doesNotMatch(out, /data-tracked/, "without leaking the wrapper");
	});

	test("the link case and the bold case are treated differently, on purpose", () => {
		// Both sit inside a modification; only one is a proposal. Guards against a
		// future tidy-up making the two consistent in the wrong direction.
		const bold = stripTrackChangesFromHTML(
			'<p><span data-tracked="modification"><strong>x</strong></span></p>',
		);
		const link = stripTrackChangesFromHTML(
			'<p><span data-tracked="modification"><a href="https://x.test">x</a></span></p>',
		);
		assert.doesNotMatch(bold, /<strong>/, "the proposal goes");
		assert.match(link, /<a href=/, "the destination stays");
	});

	test("CONTROL: the editor never creates a modification mark", () => {
		// This bounds the cost of the blunt strip. The mark is registered in the
		// schema and consumed by accept/reject, but nothing applies it, so no user
		// action can produce the collateral case. If this ever changes, the tradeoff
		// above needs revisiting — which is why it is asserted rather than assumed.
		const applies = BEHAVIOR.match(/addMark\([^)]*modification/i);
		assert.equal(applies, null, "nothing applies a modification mark");
		const creates =
			TRACK_CHANGES.match(/Mark\.create\(\{[\s\S]{0,400}?name: "modification"/) !== null;
		assert.ok(creates, "the mark exists in the schema");
	});

	test("CONTROL: the strip is not a no-op", () => {
		// Guards against an accidental rewrite that returns the input unchanged.
		const input = '<p>a <ins data-tracked="insertion">X</ins> b</p>';
		assert.notEqual(stripTrackChangesFromHTML(input), input);
	});
});
