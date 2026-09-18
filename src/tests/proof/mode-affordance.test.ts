/**
 * PHASE 7 acceptance — one selection surface, no dead read-only branch (DoD #7).
 *
 * WHAT WAS WRONG
 * --------------
 * `EditorBubbleMenu` declared a `readOnly` prop, gated the whole formatting
 * toolbar behind `!readOnly`, and offered a comment-only variant behind
 * `readOnly && onComment`. No caller ever passed it:
 *
 *     grep -rn "readOnly=" src/components/editor/   ->   (no matches)
 *
 * So both branches were dead in one direction or the other, and the read-only
 * selection surface was a SECOND, hand-rolled implementation
 * (`view-mode-comment-button.tsx`) doing its own `selectionchange` math —
 * duplicate positioning logic, and a second place for the pip bugs to live.
 *
 * THE DECISION
 * ------------
 * Keep exactly ONE selection surface per mode, chosen structurally rather than
 * by a flag:
 *
 *   editing   -> EditorBubbleMenu      (formatting + Comment + Suggest)
 *   viewing   -> ViewModeCommentButton (Comment; Suggest on source viewer)
 *
 * The `readOnly` prop is deleted rather than wired up. Wiring it would have
 * required TipTap's BubbleMenu to fire on a non-editable editor, which it does
 * not — that is precisely why the second component exists. A flag that cannot
 * work is worse than no flag.
 *
 * `docs/ux-contracts.md` §4.5 already describes this unified outcome ("the
 * read-only bubble showing only Comment is the correct gate for view mode"), so
 * code and contract now agree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const BUBBLE_MENU = path.join(ROOT, "src/components/editor/bubble-menu.tsx");
const VIEW_MODE = path.join(ROOT, "src/components/editor/view-mode-comment-button.tsx");
const EDITOR = path.join(ROOT, "src/components/editor/editor.tsx");

function read(file: string): string {
	return readFileSync(file, "utf-8");
}

test("P7: the dead readOnly prop is gone from the bubble menu", () => {
	const source = read(BUBBLE_MENU);
	assert.ok(
		!source.includes("readOnly"),
		"readOnly must be fully removed (prop, destructure and both branches)",
	);
});

test("P7: no caller passes readOnly to EditorBubbleMenu", () => {
	const editor = read(EDITOR);
	assert.ok(!editor.includes("readOnly="), "no call site passes readOnly any more");
});

test("P7: both selection surfaces still exist and are mode-gated by the editor", () => {
	// The consolidation removes a DEAD BRANCH, not the view-mode affordance.
	assert.ok(existsSync(VIEW_MODE), "the view-mode comment surface still exists");

	const editor = read(EDITOR);
	assert.ok(editor.includes("<EditorBubbleMenu"), "editing mode mounts the bubble menu");
	assert.ok(
		editor.includes("<ViewModeCommentButton"),
		"viewing mode mounts the view-mode comment surface",
	);
	// Structural gating: the two are mutually exclusive by `isViewing`.
	assert.ok(
		/\{!isViewing && \([\s\S]{0,400}<EditorBubbleMenu/.test(editor),
		"the bubble menu is gated behind !isViewing",
	);
	assert.ok(
		/\{isViewing && \([\s\S]{0,400}<ViewModeCommentButton/.test(editor),
		"the view-mode surface is gated behind isViewing",
	);
});

test("P7: the bubble menu still offers Comment and Suggest in editing mode", () => {
	const source = read(BUBBLE_MENU);
	assert.ok(source.includes("onComment"), "Comment remains available");
	assert.ok(source.includes("onSuggestEdit"), "Suggest edit remains available");
});

test("P7: the view-mode surface keeps its own selectionchange handling", () => {
	// Documented tradeoff, asserted so it cannot be forgotten: TipTap's
	// BubbleMenu does not fire on a non-editable editor, so view mode MUST
	// observe native selection. This is the reason the two surfaces cannot be
	// collapsed into one component by a flag alone.
	const source = read(VIEW_MODE);
	assert.ok(
		source.includes("selectionchange"),
		"view mode observes native selection because BubbleMenu is inert when non-editable",
	);
});