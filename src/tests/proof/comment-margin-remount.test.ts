/**
 * The expanded margin card must survive an editor remount.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Successful ops keep the thread open" is a stated constraint, and a reply broke
 * it. The reply SAVED correctly — the card gained "1 reply" — while the thread
 * closed under the reader.
 *
 * The cause was not the reply handler. `handleSend` only clears its text. The
 * editor itself was being unmounted: writing the sidecar makes the file watcher
 * report an external change, `refreshViewer()` flips `fileLoading`, and
 * `viewer-pane.tsx` swaps `<KBEditor>` for a spinner and back. Verified live — a
 * tag set on `.ProseMirror` before the send was gone after it — which means any
 * component state, including the expanded card, is destroyed.
 *
 * So the expansion is held at module scope, keyed by path, and re-seeded on mount.
 * These tests pin that arrangement, because the failure mode is silent: everything
 * still renders, the reply still saves, and only the thread quietly collapses.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const EDITOR = readFileSync(
	path.join(ROOT, "src/components/editor/editor.tsx"),
	"utf8",
);

describe("the expansion survives an editor remount", () => {
	test("the expansion is held outside the component", () => {
		// A `useState` alone is wiped by the remount; a `useRef` is recreated by it too.
		assert.match(
			EDITOR,
			/const expandedMarginByPath = new Map<string, string>\(\)/,
			"expected module-scope storage for the expanded card",
		);
		// It must be declared before the component, not inside it.
		const mapAt = EDITOR.indexOf("const expandedMarginByPath");
		const componentAt = EDITOR.indexOf("export function KBEditor(");
		assert.ok(
			mapAt > 0 && mapAt < componentAt,
			"the map must be module scope, declared before the component",
		);
	});

	test("the expansion is re-seeded when the component mounts", () => {
		assert.match(
			EDITOR,
			/useState<string \| null>\(\s*\(\) => expandedMarginByPath\.get\(currentPath \?\? ""\) \?\? null,?\s*\)/,
			"the initial state must read through to the module-scope map",
		);
	});

	test("the stored value tracks the live value", () => {
		assert.match(
			EDITOR,
			/if \(activeMarginRef\) expandedMarginByPath\.set\(key, activeMarginRef\);/,
			"an expansion must be written back",
		);
		assert.match(
			EDITOR,
			/else expandedMarginByPath\.delete\(key\);/,
			"a collapse must clear the entry, so the map cannot grow without bound",
		);
	});

	test("expansion is keyed per path, and cannot leak across documents", () => {
		// The first version of this fix DID leak. `useState`'s initializer runs once per
		// mount, but a path change need not remount: the state still held document A's
		// ref while `currentPath` already said B, so the write-back stored A's ref as
		// B's and document B opened with A's card expanded. Checking only that a `key`
		// variable existed — as an earlier version of this test did — passes on the
		// broken code, because the bug was in which path the write used, not whether a
		// path was computed.
		assert.match(
			EDITOR,
			/if \(activeMarginPathRef\.current !== key\) \{/,
			"a path change must be detected before writing back",
		);
		// On that path change the state must be re-seeded from the NEW document...
		assert.match(
			EDITOR,
			/setActiveMarginRef\(expandedMarginByPath\.get\(key\) \?\? null\);/,
			"a path change must adopt the new document's own expansion",
		);
		// ...and the write-back must not run for the old document's ref.
		const effect = EDITOR.slice(
			EDITOR.indexOf("const activeMarginPathRef = useRef"),
			EDITOR.indexOf("const [threadTarget, setThreadTarget]"),
		);
		const returnAt = effect.indexOf("return;");
		const writeAt = effect.indexOf("expandedMarginByPath.set(key, activeMarginRef)");
		assert.ok(
			returnAt > 0 && writeAt > returnAt,
			"the stale-path branch must return before any write-back",
		);
	});

	test("the mount initializer still reads the module-scope map", () => {
		// Guards against a future edit that re-seeds on path change but forgets to
		// restore the expansion after the remount this whole mechanism exists for.
		assert.match(
			EDITOR,
			/useState<string \| null>\(\s*\(\) => expandedMarginByPath\.get\(currentPath \?\? ""\) \?\? null,?\s*\)/,
			"the mount initializer must read through to the map",
		);
	});

	test("CONTROL: the reply handler still does not close the thread", () => {
		// The original suspicion was `handleSend`, which never called onClose. This
		// pins that it still does not, so a future regression there is visible rather
		// than masked by the now-correct expansion behaviour.
		const thread = readFileSync(
			path.join(ROOT, "src/components/editor/comment-thread.tsx"),
			"utf8",
		);
		const send = thread.slice(
			thread.indexOf("async function handleSend()"),
			thread.indexOf("async function handleDelete()"),
		);
		assert.ok(send.length > 0, "expected to locate handleSend");
		assert.ok(
			!send.includes("onClose"),
			"handleSend must not close the thread; only Delete should",
		);
	});
});

describe("the feedback loop that hid the real cause", () => {
	// Two changes were made while chasing the wrong explanation: clearing the
	// expansion when `marginThreads` looked empty, then that plus a 1500ms delay.
	// Both assumed the column transiently empties during a reply. Sampling the card
	// count every 100ms across a send showed it NEVER changed, so neither could have
	// been the cause — and both would have collapsed a genuinely cancelled card's
	// neighbour if a real empty state ever did occur. They are reverted; this keeps
	// them from creeping back as a plausible-looking guard.
	test("no timer clears the expansion", () => {
		assert.ok(
			!/setTimeout\(\s*\(\)\s*=>\s*setActiveMarginRef\(null\)/.test(EDITOR),
			"the delayed-clear guess must not return",
		);
	});

	test("CONTROL: the genuine cancellation path is still intact", () => {
		// Reverting the guess must not remove the real behaviour it was imitating:
		// cancelled comments still leave the column (asserted in the margin-contract
		// suite). This pins that the editor still filters them out.
		assert.match(
			EDITOR,
			/comments: list\.filter\(\(c\) => !c\.cancelledAt\)/,
			"cancelled comments must still be excluded from the margin",
		);
	});
});

describe("Suggesting mode survives a remount", () => {
	// The same remount that collapsed the margin card reset `suggesting` to false. That
	// one is a data problem rather than a cosmetic one: the reader had switched to
	// Suggesting, and after any external file change their next keystroke would edit
	// the document directly instead of being tracked as a suggestion.
	test("the mode is held outside the component", () => {
		assert.match(
			EDITOR,
			/const suggestingModeByPath = new Map<string, boolean>\(\);/,
			"expected module-scope storage for the mode",
		);
		const declAt = EDITOR.indexOf("const suggestingModeByPath");
		const componentAt = EDITOR.indexOf("export function KBEditor(");
		assert.ok(
			declAt > 0 && declAt < componentAt,
			"module scope, declared before the component",
		);
		assert.match(
			EDITOR,
			/useState\(\s*\(\) => suggestingModeByPath\.get\(currentPath \?\? ""\) \?\? false,?\s*\)/,
			"the initial state must read through to the module-scope value",
		);
	});

	test("the mode is keyed by document, so it cannot carry across files", () => {
		// An earlier version used a single global value. Opening a second document then
		// inherited the first one's mode, so its edits were tracked without the reader
		// asking — the same class of leak already fixed for the margin expansion and the
		// Source draft. Google Docs scopes mode to the document; so does this now.
		assert.ok(
			!/const suggestingModeRef = \{ value: false \};/.test(EDITOR),
			"the global singleton must not return",
		);
		const toggle = EDITOR.slice(
			EDITOR.indexOf("const toggleSuggestingMode"),
			EDITOR.indexOf("const [sourceText"),
		);
		assert.match(
			toggle,
			/suggestingModeByPath\.set\(key, true\)/,
			"enabling must record against the document",
		);
		assert.match(
			toggle,
			/suggestingModeByPath\.delete\(key\)/,
			"disabling must clear only that document",
		);
	});

	test("a path change adopts the new document's mode", () => {
		// Without this the state keeps the old mode while the map holds the new one's,
		// and the re-arm effect below would write the stale value back into the plugin.
		assert.match(
			EDITOR,
			/setSuggesting\(suggestingModeByPath\.get\(key\) \?\? false\)/,
			"switching documents must adopt that document's mode",
		);
	});

	test("the plugin is re-armed, not just the flag", () => {
		// Restoring the flag alone would leave the toolbar saying "Suggesting" while the
		// recreated plugin behaved as "editing" — the UI claiming edits are tracked when
		// they are not. This is the subtle half of the fix.
		const effect = EDITOR.slice(
			EDITOR.indexOf("// Re-arm the mode plugin"),
			EDITOR.indexOf("Repaint exact-word highlights"),
		);
		assert.ok(effect.length > 0, "expected to find the re-arm effect");
		assert.match(
			effect,
			/setEditMode\(\s*\{\s*storage: editor\.storage\s*\}/,
			"the re-arm must write into the live editor's storage",
		);
		assert.match(
			effect,
			/\},\s*\[editor, suggesting\]\)/,
			"it must re-run when a new editor instance appears",
		);
	});

	test("CONTROL: the toggle still writes through to the plugin", () => {
		// The module-scope flag is an addition, not a replacement.
		assert.match(
			EDITOR,
			/setEditMode\(\s*\{\s*storage: editorRef\.current\.storage\s*\}/,
			"the interactive toggle must still drive the plugin directly",
		);
	});
});
