/**
 * Module-scope editor state must not grow without bound, and a source-mode draft must
 * not be restored over a document that has moved on.
 *
 * Both defects come from the same design decision: four maps live at MODULE scope so
 * they survive the editor remount that external file changes trigger. That decision is
 * right — the state has to outlive the component — but it left two questions unanswered.
 *
 * UNBOUNDED GROWTH. Entries were deleted when a value went falsy for the SAME path, so a
 * document the reader simply never returned to kept its entry forever. Over a long session
 * that is one retained entry per document ever visited.
 *
 * STALE DRAFT RESTORE. `sourceDraftByPath` held a bare string with no record of which
 * revision it was typed against. A draft is unsaved text, so restoring it is only safe
 * while the document underneath has not changed; otherwise the reader's stale buffer
 * silently overwrites edits made elsewhere, with no indication anything was reverted.
 *
 * The logic is exercised through the same module the component uses. `remember` and the
 * revision check are exported from the editor module for exactly this reason: they were
 * previously unreachable from a test, which is why neither had one.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MODULE_MAP_LIMIT, remember, shouldRestoreDraft } from "@/components/editor/editor-module-state";

describe("module-scope editor maps stay bounded", () => {
	test("the cap holds when more documents are visited than the limit", () => {
		const map = new Map<string, boolean>();
		for (let i = 0; i < MODULE_MAP_LIMIT * 3; i += 1) {
			remember(map, `doc-${i}.md`, true);
		}
		assert.equal(map.size, MODULE_MAP_LIMIT, "the map cannot grow past the cap");
	});

	test("the most recent documents are kept, the oldest evicted", () => {
		// Eviction order is what makes the cap safe rather than merely bounded: the
		// documents still plausibly in play are the ones recently touched.
		const map = new Map<string, boolean>();
		for (let i = 0; i < MODULE_MAP_LIMIT + 5; i += 1) {
			remember(map, `doc-${i}.md`, true);
		}
		assert.equal(map.has("doc-0.md"), false, "the oldest entry is gone");
		assert.equal(map.has(`doc-${MODULE_MAP_LIMIT + 4}.md`), true, "the newest survives");
	});

	test("re-setting a key refreshes its position instead of duplicating it", () => {
		// Without the delete-then-set, a key that is written to repeatedly would keep
		// its original slot and be evicted while still the most recently used.
		const map = new Map<string, number>();
		remember(map, "hot.md", 1);
		for (let i = 0; i < MODULE_MAP_LIMIT - 1; i += 1) remember(map, `filler-${i}.md`, i);
		remember(map, "hot.md", 2);
		remember(map, "newcomer.md", 3);

		assert.equal(map.size, MODULE_MAP_LIMIT, "still bounded");
		assert.equal(map.get("hot.md"), 2, "and the refreshed entry survived eviction");
	});

	test("CONTROL: an unbounded map does grow — the premise", () => {
		const unbounded = new Map<string, boolean>();
		for (let i = 0; i < MODULE_MAP_LIMIT * 3; i += 1) unbounded.set(`doc-${i}.md`, true);
		assert.equal(unbounded.size, MODULE_MAP_LIMIT * 3, "unbounded, as before the fix");
	});

	test("the cap is a sane positive number", () => {
		assert.ok(MODULE_MAP_LIMIT > 0);
		assert.ok(MODULE_MAP_LIMIT <= 100, "large enough to be useless would defeat the point");
	});
});

describe("a source-mode draft is restored only against its own revision", () => {
	test("a draft from the current revision is restored", () => {
		assert.equal(
			shouldRestoreDraft({ text: "half-typed", revision: 7 }, 7),
			true,
			"same revision, so the text is still the reader's own work in progress",
		);
	});

	test("a draft from an older revision is NOT restored", () => {
		// The defect: a V1 draft restored over a V2 file silently reverts whatever the
		// V2 change was, and the reader cannot tell the buffer is older than the file.
		assert.equal(
			shouldRestoreDraft({ text: "stale buffer", revision: 1 }, 2),
			false,
			"the document moved on, so the draft must not win",
		);
	});

	test("a draft from a NEWER revision is not restored either", () => {
		// Should not happen, but restoring it would push the editor ahead of the file it
		// is editing, so the safe answer is the same.
		assert.equal(shouldRestoreDraft({ text: "from the future", revision: 9 }, 3), false);
	});

	test("no draft means nothing to restore", () => {
		assert.equal(shouldRestoreDraft(undefined, 4), false);
		assert.equal(shouldRestoreDraft(null, 4), false);
	});

	test("an empty draft is not restored", () => {
		// An empty draft is indistinguishable from no draft, and treating it as content
		// would replace the document view with nothing.
		assert.equal(shouldRestoreDraft({ text: "", revision: 4 }, 4), false);
	});

	test("CONTROL: revision 0 matches revision 0", () => {
		// Guards against a falsy-revision bug that would refuse every draft on a document
		// whose sidecar has not loaded yet.
		assert.equal(shouldRestoreDraft({ text: "x", revision: 0 }, 0), true);
	});
});