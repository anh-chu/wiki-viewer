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
import { describe, test } from "node:test";
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
/**
 * The PARITY invariant, as distinct from the per-surface checks above.
 *
 * The tests above each confirm that one surface has its handlers. Neither
 * compares them, so deleting `onSuggest` from the view-mode button would leave
 * every one of them passing while a reader silently lost the ability to propose
 * a change. That is the regression this asserts against: the capability SETS
 * must match, even though the components and their labels differ.
 */
describe("view and edit surfaces offer the same capabilities", () => {
	/** Which of the two annotation capabilities a file wires up. */
	function capabilities(file: string): { comment: boolean; suggest: boolean } {
		const source = read(file);
		return {
			// The prop names differ per component (onComment/onSuggestEdit vs
			// onComment/onSuggest), so match the shared prefix.
			comment: /\bonComment\b/.test(source),
			suggest: /\bonSuggest\w*\b/.test(source),
		};
	}

	test("both surfaces expose Comment", () => {
		assert.ok(capabilities(BUBBLE_MENU).comment, "editing surface offers Comment");
		assert.ok(capabilities(VIEW_MODE).comment, "viewing surface offers Comment");
	});

	test("both surfaces expose Suggest", () => {
		assert.ok(capabilities(BUBBLE_MENU).suggest, "editing surface offers Suggest");
		assert.ok(capabilities(VIEW_MODE).suggest, "viewing surface offers Suggest");
	});

	test("the editor passes both handlers to whichever surface it mounts", () => {
		// Parity is only real if the editor actually wires both through. A surface
		// that accepts a handler it is never given is equivalent to not having it.
		//
		// The prop NAMES differ by surface — `onSuggestEdit` on the bubble menu,
		// `onSuggest` on the view-mode button — so matching a single literal name
		// undercounts. Match the shared prefix instead; the capability is what must
		// be equal, not the spelling.
		const editor = read(EDITOR);
		for (const [capability, pattern] of [
			["Comment", /\bonComment=/g],
			["Suggest", /\bonSuggest\w*=/g],
		] as const) {
			const count = (editor.match(pattern) ?? []).length;
			assert.ok(
				count >= 2,
				`${capability} must be passed to BOTH surfaces, found ${count} call site(s)`,
			);
		}
	});

	test("CONTROL: the two surfaces really are separate components", () => {
		// If these ever collapse into one shared component the parity assertions
		// above become vacuous — they would be comparing a file to itself.
		assert.notEqual(BUBBLE_MENU, VIEW_MODE);
		assert.ok(
			!read(BUBBLE_MENU).includes("selectionchange"),
			"bubble menu relies on TipTap, not native selection",
		);
		assert.ok(
			read(VIEW_MODE).includes("selectionchange"),
			"view mode observes native selection, so the files are genuinely distinct",
		);
	});
});

describe("the comment margin is identical in view and edit mode", () => {
	// The objective's constraint is that annotation surfaces must not differ by mode.
	// The margin column satisfies it structurally: it renders from one site whose guard
	// mentions nothing about viewing, so there is no second branch that could drift.
	// Pinned here because that is easy to break by adding an `isViewing &&` to the guard
	// for what would look like a reasonable reason.
	test("the visibility guard does not consult the mode", () => {
		const source = read(EDITOR);
		const at = source.indexOf("const showCommentMargin");
		assert.ok(at > 0, "expected to find the guard");
		const guard = source.slice(at, at + 120);
		assert.ok(
			!/isViewing|readOnly/.test(guard),
			"the margin must not be gated on the mode",
		);
	});

	test("the margin renders from a single site", () => {
		const sites = read(EDITOR).match(/<CommentMargin\b/g) ?? [];
		assert.equal(
			sites.length,
			1,
			"one render site means no per-mode branches can disagree",
		);
	});

	test("CONTROL: the editor does gate other things on the mode", () => {
		// Proves the assertion above is not vacuous: this file does use isViewing to
		// gate things, so a guard free of it is a deliberate result rather than a
		// property of the file.
		assert.match(
			read(EDITOR),
			/if \(isViewing\) setSourceMode\(false\);/,
			"isViewing is used",
		);
	});
});
