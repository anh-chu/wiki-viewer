/**
 * Closing Source mode without editing must not rewrite the file.
 *
 * `handleUpdate` suppresses a save when the freshly serialized markdown equals the
 * previous serialization (`lastSerializedRef`). Entering and leaving Source mode is a
 * round trip the guard has to understand: the baseline is the ROUND-TRIPPED form
 * (`1.  one`, two spaces) while Source mode shows the file's own text (`1. one`).
 *
 * The exit branch called `updateContent(sourceText)` and `setContent(html)` but never
 * re-seeded the baseline. `setContent` fires `onUpdate`, the comparison then ran against
 * a baseline describing the pre-source-mode document, missed, and saved — reformatting
 * list markers in a file the user never edited.
 *
 * Found by independent review; measured here before fixing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { markdownToHtml } from "@/lib/markdown/to-html";

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);

/** Strip comments so an assertion is about code that runs, not text that mentions it. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The exit branch of `toggleSourceMode`.
 *
 * Located on the RAW source, because the marker is itself a line comment and
 * `stripComments` would remove it. The returned slice is stripped, so assertions over
 * it are about code that runs.
 */
function exitBranch(): string {
	const at = EDITOR.indexOf('updateContent(sourceText)');
	assert.ok(at > 0, "expected the source-mode exit branch");
	const branch = EDITOR.slice(at, EDITOR.indexOf("setSourceMode(false)", at));
	assert.ok(branch.length > 0, "the branch must not be empty");
	return stripComments(branch);
}

describe("closing Source mode is a no-op", () => {
	test("the round trip really does diverge — the premise", async () => {
		// If these matched, the missing re-seed would be harmless and the fix would be
		// pointless. Measuring it keeps the rest of the file honest.
		const source = "1. one\n2. two\n";
		const roundTripped = htmlToMarkdown(
			await markdownToHtml(source, undefined),
			undefined,
		);
		assert.notEqual(
			roundTripped,
			source,
			"the pipeline is not the identity, which is why a baseline is needed",
		);
		assert.match(roundTripped, /1\.\s\sone/, "list markers gain a second space");
	});

	test("the exit branch re-seeds the baseline", () => {
		assert.match(
			exitBranch(),
			/lastSerializedRef\.current\s*=/,
			"without this, closing source mode saves a reformatted document",
		);
	});

	test("it seeds from the editor's own serialization, the same way handleUpdate does", () => {
		// Seeding from `sourceText` would be wrong for the same reason comparing
		// against the file's source markdown is wrong: the guard compares
		// serialization to serialization, so the baseline must be one too.
		//
		// The two sides must also agree on HOW they serialize. This used to strip
		// tracked marks before converting, and the assertion pinned that call. The
		// marks are now the record of a suggestion rather than a UI layer, so they
		// are written to the file and nothing is stripped. What still has to hold
		// is that both call `htmlToMarkdown(editor.getHTML())` with no transform in
		// between - if one strips and the other does not, the baseline never
		// matches and every keystroke rewrites the document.
		const branch = exitBranch();
		assert.match(branch, /htmlToMarkdown\(editor\.getHTML\(\),/, "seeded from the live editor");
		assert.doesNotMatch(
			branch,
			/stripTrackChangesFromHTML/,
			"and not transformed, or it will not match handleUpdate",
		);
	});

	test("the re-seed happens after setContent, not before", () => {
		// Seeding first would capture the OLD document and leave the same miss.
		const branch = exitBranch();
		const setContentAt = branch.indexOf("editor.commands.setContent(html)");
		const seedAt = branch.indexOf("lastSerializedRef.current =");
		assert.ok(setContentAt > 0, "the branch must set the content");
		assert.ok(seedAt > 0, "and re-seed");
		assert.ok(
			setContentAt < seedAt,
			"the baseline must describe the content that was just set",
		);
	});

	test("the user's typed source text still reaches the store", () => {
		// The re-seed must not swallow a genuine edit made in Source mode.
		assert.match(exitBranch(), /updateContent\(sourceText\)/);
	});

	test("CONTROL: the entry branch does not touch the baseline", () => {
		// Entering source mode changes nothing on disk, so it has no reason to seed.
		// Pins that the fix landed in the right branch.
		const at = EDITOR.indexOf("// Switching TO source mode");
		const entry = stripComments(EDITOR.slice(at, EDITOR.indexOf("} else {", at)));
		assert.doesNotMatch(entry, /lastSerializedRef\.current\s*=/);
	});

	test("CONTROL: the comment stripper is not vacuous", () => {
		assert.equal(stripComments("// lastSerializedRef.current = 1;\n").includes("lastSerializedRef"), false);
		assert.equal(stripComments("lastSerializedRef.current = 1;").includes("lastSerializedRef"), true);
	});
});
