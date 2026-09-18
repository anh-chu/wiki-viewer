/**
 * Source mode must survive an editor remount.
 *
 * WHY THIS EXISTS
 * ---------------
 * Source mode is a plain <textarea> holding the file's markdown. The editor is
 * unmounted on any external file change — `refreshViewer()` flips `fileLoading` and
 * `viewer-pane.tsx` swaps `<KBEditor>` for a spinner and back (verified live: a tag
 * set on `.ProseMirror` before such a change was gone after it).
 *
 * That remount reset BOTH halves of Source mode: `sourceText` to "" and `sourceMode`
 * to false. A reader typing markdown source would be dropped back into the rendered
 * view with their draft silently discarded. There is no warning and no undo — the
 * store still holds the older content, so re-entering Source would reload that
 * instead of the draft.
 *
 * The model below is executed, not just asserted about: it reproduces the state
 * machine the component implements (path change adopts, same path writes back) so the
 * transitions are checked rather than described.
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

/** A faithful model of the component's source-mode state machine. */
function makeModel() {
	const mode = new Map<string, boolean>();
	const draft = new Map<string, string>();
	let currentPath = "A";
	let pathRef: string | null = "A";
	let srcMode = false;
	let srcText = "";

	return {
		get state() {
			return { srcMode, srcText, currentPath };
		},
		set(next: { srcMode: boolean; srcText: string }) {
			srcMode = next.srcMode;
			srcText = next.srcText;
		},
		/** The write-back / adopt effect. */
		effect() {
			if (pathRef !== currentPath) {
				pathRef = currentPath;
				srcMode = mode.get(currentPath) ?? false;
				srcText = draft.get(currentPath) ?? "";
				return;
			}
			if (srcMode) mode.set(currentPath, true);
			else mode.delete(currentPath);
			if (srcText) draft.set(currentPath, srcText);
			else draft.delete(currentPath);
		},
		/** What the useState initializer does on a fresh mount. */
		remount() {
			srcMode = mode.get(currentPath) ?? false;
			srcText = draft.get(currentPath) ?? "";
		},
		navigate(to: string) {
			currentPath = to;
		},
		draftFor(p: string) {
			return draft.get(p) ?? null;
		},
	};
}

describe("source mode survives an editor remount", () => {
	test("a draft typed in Source mode survives the remount", () => {
		const m = makeModel();
		m.set({ srcMode: true, srcText: "# my draft" });
		m.effect();
		m.remount();
		assert.equal(m.state.srcMode, true, "Source mode must still be on");
		assert.equal(m.state.srcText, "# my draft", "the draft must survive");
	});

	test("the draft does not leak onto another document", () => {
		// Same failure the margin expansion had: a path change need not remount, so a
		// write-back keyed only on the live value stores A's draft under B.
		const m = makeModel();
		m.set({ srcMode: true, srcText: "# draft A" });
		m.effect();
		m.navigate("B");
		m.effect();
		assert.equal(m.state.srcMode, false, "B starts with its own mode");
		assert.equal(m.state.srcText, "", "B must not inherit A's draft");
		assert.equal(m.draftFor("B"), null, "nothing may be stored under B");
	});

	test("returning to the first document restores its draft", () => {
		const m = makeModel();
		m.set({ srcMode: true, srcText: "# draft A" });
		m.effect();
		m.navigate("B");
		m.effect();
		m.navigate("A");
		m.effect();
		assert.equal(m.state.srcMode, true, "A's mode is restored");
		assert.equal(m.state.srcText, "# draft A", "A's draft is restored");
	});

	test("the component actually implements this arrangement", () => {
		assert.match(
			EDITOR,
			/const sourceDraftByPath = new Map<string, string>\(\);/,
			"expected module-scope draft storage",
		);
		assert.match(
			EDITOR,
			/const sourceModeByPath = new Map<string, boolean>\(\);/,
			"expected module-scope mode storage",
		);
		// Both must be declared before the component.
		const componentAt = EDITOR.indexOf("export function KBEditor(");
		for (const decl of ["const sourceDraftByPath", "const sourceModeByPath"]) {
			const at = EDITOR.indexOf(decl);
			assert.ok(at > 0 && at < componentAt, `${decl} must be module scope`);
		}
		assert.match(
			EDITOR,
			/useState\(\s*\(\) => sourceDraftByPath\.get\(currentPath \?\? ""\) \?\? "",?\s*\)/,
			"the draft must be re-seeded on mount",
		);
	});

	test("CONTROL: the draft is recorded on every change, not only on toggle", () => {
		// Writing back only when toggling Source would still lose everything typed since
		// the toggle, which is the whole window the remount can land in.
		const effect = EDITOR.slice(
			EDITOR.indexOf("// Record Source mode and its draft on every change"),
			EDITOR.indexOf("const [threadTarget"),
		);
		assert.ok(effect.length > 0, "expected to find the write-back effect");
		assert.match(
			effect,
			/if \(sourceText\) sourceDraftByPath\.set\(key, sourceText\);/,
			"every draft change must be persisted",
		);
		assert.match(
			effect,
			/\}, \[sourceMode, sourceText, currentPath\]\)/,
			"the effect must depend on the draft text itself",
		);
	});
});
