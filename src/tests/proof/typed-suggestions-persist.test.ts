/**
 * Typed tracked edits must create a sidecar suggestion, not a silent permanent edit.
 *
 * The defect this pins: `TrackChangesOptions.onTrackedEdit` is documented as "called
 * after a tracked edit lands, so the sidecar can record it", but the editor never
 * passed it. Typing in Suggesting mode therefore stamped marks, and the serialization
 * strip removed them on save — so the text became a plain permanent edit with no
 * suggestion record. On screen it looked pending; in the file it was already applied;
 * a reload showed no suggestion at all. That is worse than either failure alone.
 *
 * The extension's own test asserted the callback fires, in isolation, and passed
 * while production stayed unwired. These cases check the WIRING, which is where the
 * defect actually lived.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);
const PERSIST = readFileSync(
	new URL("../../components/editor/use-tracked-edit-persistence.ts", import.meta.url),
	"utf8",
);

/** Strip comments so assertions are about code that runs, not text that mentions it. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("typed tracked edits reach the sidecar", () => {
	test("the editor passes onTrackedEdit to the extension", () => {
		const code = stripComments(EDITOR);
		assert.match(
			code,
			/onTrackedEdit:/,
			"without this the marks are stripped on save and nothing records them",
		);
	});

	test("onTrackedEdit is inside the trackChangesExtension options", () => {
		// Passing it somewhere else would not reach the plugin.
		const code = stripComments(EDITOR);
		const at = code.indexOf("trackChangesExtension(");
		assert.ok(at > 0, "the extension must be registered");
		const call = code.slice(at, code.indexOf("]) as typeof editorExtensions", at));
		assert.match(call, /onTrackedEdit:/, "the option belongs in this call");
		assert.match(call, /author:\s*\(\)\s*=>\s*"human"/, "alongside the author");
	});

	test("the callback writes a suggestion through the agent API", () => {
		const code = stripComments(PERSIST);
		assert.match(code, /suggestion\.add/, "a suggestion must be created");
		assert.match(code, /postOp\(/, "through the same path the Suggest button uses");
	});

	test("consecutive keystrokes are coalesced, not one suggestion per character", () => {
		// onTrackedEdit fires per transaction, so a typed word arrives as several
		// calls. Without merging, typing "hello" would leave five one-letter cards
		// in the margin.
		const code = stripComments(PERSIST);
		assert.match(code, /COALESCE_MS/, "there must be a coalescing window");
		assert.match(code, /continuing/, "and a branch that extends the open run");
	});

	test("a run is keyed by block and kind", () => {
		// Otherwise typing in one paragraph then another appends to the wrong
		// suggestion, and a deletion folds into an insertion.
		const code = stripComments(PERSIST);
		assert.match(code, /`\$\{path\}:\$\{ref\}:\$\{kind\}`/, "the run key names all three");
	});

	test("the extension list stays stable across renders", () => {
		// The extensions memo must not depend on the callback, or every render would
		// rebuild the editor and destroy its state — the remount defect this branch
		// already had to fix once.
		const code = stripComments(EDITOR);
		assert.match(code, /trackedEditRef\.current\(info\)/, "read through a ref");
		assert.match(code, /trackedEditRef\.current = handleTrackedEdit/, "which is kept current");
	});

	test("CONTROL: the strip really does remove the marks that were unrecorded", () => {
		// Establishes the premise. If the strip did not remove insertion marks, the
		// unwired state would merely save the marks instead of losing them.
		const code = stripComments(EDITOR);
		assert.match(code, /stripTrackChangesFromHTML\(editor\.getHTML\(\)\)/);
	});

	test("CONTROL: the comment stripper used above is not vacuous", () => {
		assert.equal(stripComments("// onTrackedEdit:\n").includes("onTrackedEdit"), false);
		assert.equal(stripComments("onTrackedEdit: (i) => i,").includes("onTrackedEdit"), true);
	});
});
