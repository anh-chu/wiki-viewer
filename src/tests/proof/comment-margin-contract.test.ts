/**
 * Margin column contract: resolved threads stay, and threads render in place.
 *
 * Two defects lived here, both of which made the column look like it worked while
 * it did not. Neither was visible to the layout tests, because the layout was
 * correct in both cases — the failure was in what got mounted.
 *
 * 1. RESOLVED THREADS VANISHED. `marginThreads` filtered resolved comments out, so
 *    resolving unmounted the card, which unmounted the thread inside it. A
 *    successful Resolve therefore closed the thread and removed the reply box,
 *    contradicting "resolved threads always show the reply box" and "successful ops
 *    keep the thread open".
 *
 * 2. THE MARGIN THREAD NEVER RENDERED. `CommentThread` opened with a popover
 *    positioning guard (`if (!anchorEl || !anchor) return null`) that ran BEFORE
 *    the margin branch. A margin card has no floating anchor to measure, so it
 *    passed `anchorEl={null}` and the thread returned null every time — an expanded
 *    card was an empty zero-height box. Measured live: card heights
 *    `[0, 55, 55, 74]`, with the expanded one at 0.
 *
 * These are tested at the source level because the defects are ordering and
 * filtering decisions, not rendering math.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const THREAD = readFileSync(
	new URL("../../components/editor/comment-thread.tsx", import.meta.url),
	"utf8",
);
const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);

/** Index of the first line containing `needle`. Fails loudly when absent. */
function lineOf(source: string, needle: string): number {
	const idx = source.split("\n").findIndex((l) => l.includes(needle));
	assert.notEqual(idx, -1, `expected to find ${JSON.stringify(needle)}`);
	return idx;
}

describe("resolved threads stay in the margin column", () => {
	test("marginThreads does not filter out resolved comments", () => {
		const block = EDITOR.slice(
			EDITOR.indexOf("const marginThreads = useMemo("),
			EDITOR.indexOf("const showCommentMargin ="),
		);
		assert.ok(block.length > 0, "expected to find the marginThreads memo");
		assert.ok(
			!block.includes("!c.resolved"),
			"dropping resolved comments unmounts their card and closes the thread",
		);
		assert.ok(
			block.includes("!c.cancelledAt"),
			"cancelled comments still have no anchor, so they must stay excluded",
		);
	});

	test("CONTROL: a cancelled comment is still excluded", () => {
		// Cancellation is the one case that must NOT appear: the anchor is gone, so
		// there is nothing to point at. If this ever stops holding, the fix above
		// went too far.
		const block = EDITOR.slice(
			EDITOR.indexOf("const marginThreads = useMemo("),
			EDITOR.indexOf("const showCommentMargin ="),
		);
		assert.match(block, /filter\(\(c\) => !c\.cancelledAt\)/);
	});
});

describe("the margin thread renders without a floating anchor", () => {
	test("the margin branch precedes the popover positioning guard", () => {
		const marginBranch = lineOf(THREAD, 'if (variant === "margin") {');
		const popoverGuard = lineOf(THREAD, "if (!anchorEl || !anchor) return null;");
		assert.ok(
			marginBranch < popoverGuard,
			`the margin branch (line ${marginBranch + 1}) must come before the popover ` +
				`guard (line ${popoverGuard + 1}); otherwise it returns null for every ` +
				"margin card and the expanded thread is an empty box",
		);
	});

	test("the popover guard still protects the popover path", () => {
		// The guard is legitimate for the floating popover, which positions itself
		// against a measured element. It must not have been deleted outright.
		assert.ok(
			THREAD.includes("if (!anchorEl || !anchor) return null;"),
			"the popover still needs its anchor guard",
		);
	});

	test("the margin variant does not steal focus on mount", () => {
		// The popover focuses its textarea when it positions. A margin card is opened
		// by an explicit click, so stealing focus would fight the click target.
		const focusBlock = THREAD.slice(
			THREAD.indexOf("setTimeout(() => textareaRef.current?.focus()"),
			THREAD.indexOf("setTimeout(() => textareaRef.current?.focus()") + 120,
		);
		assert.ok(focusBlock.length > 0, "expected to find the focus effect");
		assert.ok(
			THREAD.includes('variant !== "margin"'),
			"the focus effect must skip the margin variant",
		);
	});
});

describe("an expanded margin card can be collapsed again", () => {
	test("the margin variant renders a close control", () => {
		// Expanding unmounts the collapsed card whose button set the state, so the
		// card itself must offer a way back. Without this, expanding a comment was a
		// one-way trip: measured live, every button left in the expanded card was an
		// edit action (Edit, Delete, Turn into an instruction, Reopen, Send).
		const marginStart = THREAD.indexOf('if (variant === "margin") {');
		const popoverGuard = THREAD.indexOf("if (!anchorEl || !anchor) return null;");
		const marginBranch = THREAD.slice(marginStart, popoverGuard);
		assert.ok(marginBranch.length > 0, "expected to find the margin branch");
		assert.match(
			marginBranch,
			/aria-label="Collapse comment"/,
			"the margin card needs its own collapse control",
		);
		assert.match(
			marginBranch,
			/onClick=\{onClose\}/,
			"the control must call the onClose the margin already passes",
		);
	});

	test("the editor passes a real close handler to the column", () => {
		// Routed through the helper that also updates the module-scope record, so the
		// close survives alongside the expansion. Asserting the helper name rather than
		// `setActiveMarginRef(null)` directly, which would now miss the real call.
		assert.match(
			EDITOR,
			/onClose=\{\(\) => setActiveMarginRefNow\(null\)\}/,
			"the column's close must clear the expanded ref, not a different target",
		);
	});

	test("both close paths record the change outside component state", () => {
		// The expansion is stored at click time, not only in an effect, so a remount
		// landing before the effect runs cannot re-open the card collapsed.
		assert.match(
			EDITOR,
			/const setActiveMarginRefNow = useCallback\(/,
			"expected a helper that writes through to the map",
		);
		assert.match(
			EDITOR,
			/if \(blockRef\) remember\(expandedMarginByPath, key, blockRef\);/,
			"expanding must be recorded immediately",
		);
		assert.match(
			EDITOR,
			/else expandedMarginByPath\.delete\(key\);/,
			"collapsing must be recorded immediately",
		);
	});

	test("CONTROL: the popover's Escape path does not cover the margin", () => {
		// The Escape handler is inside an effect keyed on `anchorEl`, which is null for
		// margin cards — so it cannot be the margin's escape route. This is why a
		// dedicated control is required rather than relying on the existing one.
		assert.match(
			THREAD,
			/if \(anchor && variant !== "margin"\)/,
			"the focus effect (and the Escape effect beside it) is popover-only",
		);
	});
});

describe("resolved threads always offer the reply box", () => {
	// An objective constraint, and one that is easy to break by hiding the composer
	// behind a resolved check — which would look tidy and would strand a reader who
	// wants to respond to a resolved thread. Verified in the running app: the resolved
	// card b55b0d0 (showing "Reopen") expands with a textarea present.
	test("the composer is not gated on the resolved state", () => {
		const source = THREAD;
		const at = source.indexOf("Reply / new comment footer");
		assert.ok(at > 0, "expected to find the composer region");
		// Everything from the marker to the end of the textarea element.
		const region = source.slice(at, at + 700);
		assert.ok(
			!/activeComment\.resolved\s*&&/.test(region),
			"the reply box must not be conditional on being unresolved",
		);
		assert.match(region, /<textarea/, "and it must actually be a textarea");
	});

	test("the placeholder adapts to the thread's state", () => {
		// The box is always present, but its wording tells the reader which act they are
		// performing. Losing this would leave "Add a comment…" on a thread that already
		// has one.
		assert.match(
			THREAD,
			/hasOpen \? "Reply…" : "Add a comment…"/,
			"the placeholder must reflect whether the thread is open",
		);
	});

	test("CONTROL: the resolved state IS used elsewhere in the thread", () => {
		// Proves the assertion above is not vacuous: this component does branch on
		// `resolved`, for the Resolve/Reopen control, so a composer free of it is a
		// deliberate result rather than an absence of any such branch.
		assert.match(
			THREAD,
			/activeComment\.resolved \? "Reopen" : "Resolve"/,
			"the resolve control branches on the same state",
		);
	});
});
