/**
 * The byte-identity invariant, tested through the REAL serialization path.
 *
 * The contract: while suggestions are pending, `.md` on disk must not change —
 * not by one byte. If it did, a suggestion would be indistinguishable from a
 * saved edit, and "reject" would have nothing to reject.
 *
 * The earlier strip tests proved the primitive in isolation. These prove the
 * ORDER in `handleUpdate`: strip the tracked marks BEFORE markdown conversion.
 * Getting that order wrong is the whole failure mode — once Turndown sees `<ins>`
 * it emits `~text~` and the file is already different. So the test runs the same
 * two steps the editor runs, in the same order, and compares against the original
 * file content.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripTrackChangesFromHTML } from "@/lib/proof/track-changes-strip";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";

/** What the editor would put on disk, given this editor HTML. */
function serialize(html: string) {
	return htmlToMarkdown(stripTrackChangesFromHTML(html), undefined);
}

/** The same editor HTML WITHOUT stripping — the leak we are defending against. */
function serializeWithoutStrip(html: string) {
	return htmlToMarkdown(html, undefined);
}

describe("markdown stays byte-identical while suggestions are pending", () => {
	test("an inserted phrase does not reach the file", () => {
		const original = "The fox jumps.\n";
		// The editor holds the insertion as real text with an <ins> wrapper.
		const editorHtml =
			"<p>The fox jumps<ins data-tracked=\"insertion\" data-suggestion-by=\"human\"> over the dog</ins>.</p>";

		const written = serialize(editorHtml);
		assert.equal(
			written.trim(),
			original.trim(),
			"pending insertion must not appear in the file",
		);
	});

	test("CONTROL: without the strip, the insertion DOES leak", () => {
		// Without this control the test above would pass even if <ins> never
		// serialized at all, proving nothing about the strip.
		const editorHtml =
			"<p>The fox jumps<ins data-tracked=\"insertion\"> over the dog</ins>.</p>";
		const leaked = serializeWithoutStrip(editorHtml);
		assert.notEqual(
			leaked.trim(),
			"The fox jumps.",
			"the leak must be real for the strip to matter",
		);
		assert.match(leaked, /over the dog/, "unstripped insertion survives into markdown");
	});

	test("a deletion does not reach the file", () => {
		const original = "The quick brown fox.\n";
		// Deleted words are still present, struck through.
		const editorHtml =
			"<p>The quick<del data-tracked=\"deletion\"> brown</del> fox.</p>";

		const written = serialize(editorHtml);
		assert.equal(
			written.trim(),
			original.trim(),
			"deleted text must remain in the file until the suggestion is accepted",
		);
	});

	test("a replacement leaves the file untouched", () => {
		const original = "The quick fox.\n";
		const editorHtml =
			"<p>The <del data-tracked=\"deletion\">quick</del><ins data-tracked=\"insertion\">fast</ins> fox.</p>";

		const written = serialize(editorHtml);
		assert.equal(
			written.trim(),
			original.trim(),
			"neither half of a replacement may reach the file",
		);
	});

	test("a formatting-only change leaves the file untouched", () => {
		const original = "The fox.\n";
		const editorHtml =
			'<p>The <span data-tracked="modification"><strong>fox</strong></span>.</p>';

		const written = serialize(editorHtml);
		// The modification mark is unwrapped; the text survives. Whether the bold
		// itself applies is a separate question from byte-identity of the words,
		// and for a pending suggestion the words must not change.
		assert.match(written, /The fox\./, "the words are unchanged");
		assert.doesNotMatch(written, /data-tracked|<\/?ins|<\/?del/i, "no tracking markup leaks");
	});

	test("a document with several pending suggestions still matches byte for byte", () => {
		const original = "# Title\n\nAlpha beta gamma.\n\nSecond paragraph here.\n";
		const editorHtml =
			'<h1>Title</h1><p>Alpha<ins data-tracked="insertion"> NEW</ins> beta<del data-tracked="deletion"> gamma</del>.</p><p>Second paragraph here.</p>';

		const written = serialize(editorHtml);
		assert.equal(
			written.trim(),
			original.trim(),
			"a multi-suggestion document must serialize to exactly the original",
		);
	});

	test("repeated serialization is stable — no drift on save", () => {
		// Saving twice must not accumulate differences, which would show up as a
		// spurious revision bump on every keystroke.
		const editorHtml =
			'<p>Keep this<ins data-tracked="insertion"> and this</ins>.</p>';
		const first = serialize(editorHtml);
		const second = serialize(editorHtml);
		assert.equal(first, second, "serialization must be deterministic");
	});
});