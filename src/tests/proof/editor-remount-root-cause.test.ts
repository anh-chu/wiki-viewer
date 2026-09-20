/**
 * The editor must not be unmounted by a reload.
 *
 * ROOT CAUSE
 * ----------
 * Three separate defects were found and fixed one at a time: the expanded comment card
 * collapsed, Suggesting mode reverted to Editing, and Source mode discarded its
 * markdown draft. All three had the same cause, and it was one line:
 *
 *     {fileLoading ? <Spinner/> : <KBEditor mode="viewing" />}
 *
 * `fileLoading` goes true on every external file change, not only the first load, so
 * the spinner REPLACED the editor and unmounted it — destroying all component state.
 * Verified live: a tag set on `.ProseMirror` before such a change was gone after it.
 *
 * Fixing each symptom with its own module-scope map worked but left the trap in place
 * for the next piece of state. This fixes the cause: the editor stays mounted and the
 * spinner is reserved for the genuine first load, which is also when there is no
 * editor to preserve.
 *
 * The editor already paints its own overlay spinner (`showLoadingOverlay`), so the
 * outer swap was redundant as well as destructive.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const PANE = readFileSync(
	path.join(ROOT, "src/components/wiki/viewer-pane.tsx"),
	"utf8",
);

describe("the editor is not unmounted by a reload", () => {
	test("the spinner is gated on a first load, not on fileLoading alone", () => {
		assert.match(
			PANE,
			/\{fileLoading && !hasRenderedEditor \? \(/,
			"the spinner must be reserved for a first load",
		);
	});

	test("CONTROL: fileLoading alone no longer swaps the EDITOR out", () => {
		// Scoped to the markdown/editor branch deliberately. Two other `fileLoading ?`
		// swaps exist in this file and are fine: one is a refresh-icon toggle in the
		// toolbar, the other guards a plain-text <pre>. Neither holds component state, so
		// neither can lose any. A whole-file regex would fail on those and be wrong.
		const marker = '<KBEditor mode="viewing" />';
		const at = PANE.indexOf(marker);
		assert.ok(at > 0, "expected to find the viewing editor");
		// Look back over the conditional that governs it.
		const branch = PANE.slice(Math.max(0, at - 700), at);
		assert.match(
			branch,
			/\{fileLoading && !hasRenderedEditor \? \(/,
			"the editor's spinner must be gated on a first load",
		);
		assert.ok(
			!/\{fileLoading \? \(/.test(branch),
			"an ungated `fileLoading ?` must not govern the editor",
		);
	});

	test("the flag is written from an effect, not during render", () => {
		// A render-time ref write is observable by concurrent rendering and can leave the
		// flag set for a render that is then discarded.
		assert.match(
			PANE,
			/useEffect\(\(\) => \{\s*if \(!fileLoading\) setHasRenderedEditor\(true\);\s*\}, \[fileLoading\]\);/,
			"the flag must be set in an effect",
		);
		assert.ok(
			!/hasRenderedEditorRef\.current = hasRenderedEditorRef\.current \|\|/.test(PANE),
			"the flag must not be mutated during render",
		);
	});

	test("the flag resets for a genuinely different file", () => {
		// Otherwise the next document skips its first-load spinner and renders an empty
		// editor while its content is still arriving.
		const resetEffect = PANE.slice(
			PANE.indexOf("// Reset when the file genuinely changes"),
			PANE.indexOf("const [toolbarBadgeSlotEl"),
		);
		assert.ok(resetEffect.length > 0, "expected to find the reset effect");
		assert.match(
			resetEffect,
			/setHasRenderedEditor\(false\);/,
			"a file change must re-arm the spinner",
		);
		assert.match(
			resetEffect,
			/\}, \[openFile\.path\]\);/,
			"the reset must be keyed on the open file",
		);
	});

	test("CONTROL: the first-load spinner still exists", () => {
		// The fix must not remove loading feedback, only stop it from destroying state.
		assert.match(PANE, /<Loader2 className="h-5 w-5 animate-spin/, "spinner retained");
	});
});
