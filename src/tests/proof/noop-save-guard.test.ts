/**
 * Opening a document for editing must not rewrite it.
 *
 * Markdown -> HTML -> Markdown is not the identity in this editor. A round-trip
 * turns `1. ` into `1.  ` (list markers gain a second space), gives blank lines
 * trailing whitespace, and drops the trailing newline. ProseMirror fires `onUpdate`
 * when the editor becomes editable, so the round-trip was being SAVED on a plain
 * mode switch — measured live: a 166-byte file became 231 bytes with nothing typed.
 *
 * `.md` is the source of truth here, so a visit that changes nothing must not write.
 * The file is the user's, and a silent reformat on open is data loss in the sense
 * that matters: their bytes are gone.
 *
 * The fix compares each serialization against the PREVIOUS one and skips the save
 * when they match. The baseline must be seeded at load time with what the document
 * serializes to, not left null — null guarantees the first update writes, which is
 * precisely the bug.
 *
 * These assert the guard's shape at source level because the failure is a
 * comparison between two values that are easy to confuse: the file's source
 * markdown and the round-tripped markdown. Comparing those to each other never
 * matches, which is how the first attempt at this guard ended up inert.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);

/** The body of the serialize-and-stage path, up to the next hook.
 *
 * The guard and the save live in `serializeAndStage`, which handleUpdate delegates
 * to; the settle path calls it too, so the guard covers both entry points.
 */
function handleUpdateBody(): string {
	const start = EDITOR.indexOf("const serializeAndStage = useCallback(");
	assert.notEqual(start, -1, "expected to find serializeAndStage");
	const end = EDITOR.indexOf("const commentHighlightStateRef", start);
	assert.notEqual(end, -1, "expected it to be followed by the next hook");
	return EDITOR.slice(start, end);
}

describe("a no-op edit round-trip is not saved", () => {
	test("handleUpdate returns early when the serialization is unchanged", () => {
		const body = handleUpdateBody();
		assert.match(
			body,
			/if \(lastSerializedRef\.current === md\) return;/,
			"a no-op serialization must not reach updateContent",
		);
		assert.ok(
			body.indexOf("lastSerializedRef.current === md") <
				body.indexOf("updateContent(md)"),
			"the guard must run BEFORE the save, or it guards nothing",
		);
	});

	test("the baseline is updated so consecutive no-ops all match", () => {
		assert.match(
			handleUpdateBody(),
			/lastSerializedRef\.current = md;/,
			"without recording the new value, a second identical update would still save",
		);
	});

	test("the comparison is serialization-to-serialization", () => {
		// The trap: comparing `md` (round-tripped) against the file's source markdown
		// never matches, so the guard never fires. The first attempt did exactly this.
		const body = handleUpdateBody();
		assert.ok(
			!body.includes("renderedKeyRef.current === key"),
			"comparing against the source markdown makes the guard inert",
		);
	});

	test("the baseline is SEEDED at load, not reset to null", () => {
		// Resetting to null guarantees the first update after a load writes the file —
		// and becoming editable fires exactly that first update.
		assert.ok(
			!EDITOR.includes("lastSerializedRef.current = null;"),
			"a null baseline guarantees the first post-load update writes the file",
		);
		const seedIdx = EDITOR.indexOf("lastSerializedRef.current = htmlToMarkdown(");
		assert.notEqual(
			seedIdx,
			-1,
			"the baseline must be seeded with the loaded document's serialization",
		);
		assert.ok(
			seedIdx < EDITOR.indexOf("renderedKeyRef.current = key;"),
			"seeding must happen with the same setContent that loaded the document",
		);
	});

	test("CONTROL: a real change still saves", () => {
		// The guard must block only no-ops. If it blocked real edits it would be silent
		// data loss in the other direction — worse than the bug it fixes.
		const body = handleUpdateBody();
		assert.match(
			body,
			/useEditorStore\.getState\(\)\.updateContent\(md\);/,
			"the save path must still exist behind the guard",
		);
	});
});