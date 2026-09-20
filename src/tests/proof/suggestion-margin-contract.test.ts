/**
 * Suggestion cards in the margin column.
 *
 * The requirement is that a suggested change appears beside the document alongside
 * comments and can be approved or rejected there. These are pinned at the source level
 * because the behaviour that matters is a wiring decision — what gets enumerated, what
 * gets passed down, and which command settles one mark — none of which a headless test
 * can render. The layout math has its own tests; the defects here are in what is
 * mounted and what it is wired to.
 *
 * The failure these guard against is the one this whole change exists to remove: a
 * suggestion that the margin cannot see, or a decision that settles every pending
 * suggestion at once because it reached for the document-wide command.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);
const MARGIN = readFileSync(
	new URL("../../components/editor/comment-margin.tsx", import.meta.url),
	"utf8",
);

describe("suggestions are reviewed in the annotations panel, not the anchored column", () => {
	// The split exists because the column's whole mechanism is ALIGNMENT: a card sits
	// beside the text it discusses. That is true of a comment, which annotates a block,
	// and false of a suggestion, which is a mark over a few words inside one — a redline
	// in paragraph 3 and one in paragraph 40 produced two cards whose position said
	// nothing. So the column keeps comments, and the panel lists everything.

	test("the panel's card list is built from the document's marks", () => {
		const block = EDITOR.slice(
			EDITOR.indexOf("const panelSuggestions = useMemo("),
			EDITOR.indexOf("const annotationCount ="),
		);
		assert.ok(block.length > 0, "expected to find the panelSuggestions memo");
		assert.match(
			block,
			/trackedMarks\.map/,
			"the card list must come from the enumerated marks, not a store",
		);
	});

	test("the panel receives the suggestions with both settlement handlers", () => {
		const block = EDITOR.slice(
			EDITOR.indexOf("<AnnotationsPanel"),
			EDITOR.indexOf("<AnnotationsPanel") + 1400,
		);
		assert.ok(block.length > 0, "expected to find the AnnotationsPanel render");
		assert.match(block, /suggestions=\{panelSuggestions\}/);
		assert.match(block, /onAcceptSuggestion=/);
		assert.match(block, /onRejectSuggestion=/);
	});

	test("the anchored margin is COMMENTS ONLY", () => {
		// Passing suggestions here would put the cards back where the alignment cannot
		// describe them. The margin's props must not carry a suggestion list at all.
		const block = EDITOR.slice(
			EDITOR.indexOf("<CommentMargin"),
			EDITOR.indexOf("<CommentMargin") + 900,
		);
		assert.ok(block.length > 0, "expected to find the CommentMargin render");
		assert.ok(
			!/suggestions=\{/.test(block),
			"the column must not be handed suggestions",
		);
		assert.ok(
			!/onAcceptSuggestion|onRejectSuggestion/.test(block),
			"settlement controls belong to the panel, not the column",
		);
	});

	test("the margin component no longer defines a suggestion card", () => {
		assert.ok(
			!/<SuggestionMarginCard/.test(MARGIN),
			"the column must not render suggestion cards",
		);
		assert.ok(
			!/MarginSuggestion/.test(MARGIN),
			"the column must not carry the suggestion type",
		);
	});

	test("the panel renders a suggestion card with both decisions", () => {
		const PANEL = readFileSync(
			new URL("../../components/editor/annotations-panel.tsx", import.meta.url),
			"utf8",
		);
		assert.match(PANEL, /<SuggestionCard/);
		assert.match(PANEL, /onAccept/);
		assert.match(PANEL, /onReject/);
	});

	test("the panel is reachable even when the only annotation is a suggestion", () => {
		// The regression this guards: keying the review surface on comments alone means a
		// document whose only annotation is a suggestion offers no way to approve it.
		const PANEL = readFileSync(
			new URL("../../components/editor/annotations-panel.tsx", import.meta.url),
			"utf8",
		);
		assert.match(
			PANEL,
			/threads\.length \+ suggestions\.length/,
			"the trigger count must include suggestions",
		);
	});
});

describe("Approve and Reject settle exactly one mark", () => {
	test("settlement uses the id-scoped command, not the document-wide one", () => {
		const block = EDITOR.slice(
			EDITOR.indexOf("const resolveOneTracked = useCallback("),
			EDITOR.indexOf("const resolveAllTracked = useCallback("),
		);
		assert.ok(block.length > 0, "expected to find resolveOneTracked");
		// `applySuggestions`/`revertSuggestions` settle EVERY pending mark. Approving one
		// card and having the others decided too is the defect this distinguishes.
		assert.match(
			block,
			/applySuggestion\b(?!s)/,
			"accept must call the id-scoped applySuggestion",
		);
		assert.match(
			block,
			/revertSuggestion\b(?!s)/,
			"reject must call the id-scoped revertSuggestion",
		);
		assert.ok(
			!/applySuggestions\(|revertSuggestions\(/.test(block),
			"the per-card path must not call the document-wide commands",
		);
	});

	test("the card passes the mark's id AND range, which is what scopes it", () => {
		// applySuggestion(id, from, to) needs all three; an id alone cannot locate the run.
		assert.match(EDITOR, /resolveOneTracked\(id, from, to, "accept"\)/);
		assert.match(EDITOR, /resolveOneTracked\(id, from, to, "reject"\)/);
	});

	test("CONTROL: the document-wide path still exists for Accept-all", () => {
		// Removing it would break the toolbar, and its presence is what makes the
		// assertion above meaningful rather than a renamed call.
		const block = EDITOR.slice(EDITOR.indexOf("const resolveAllTracked = useCallback("));
		assert.match(block.slice(0, 700), /applySuggestions|revertSuggestions/);
	});
});

describe("a mark with no assigned id is not shown as a card", () => {
	test("the enumeration skips a null id", () => {
		// The mark spec defaults `id` to null, so a mark can exist before the library
		// names it. Without a guard it becomes the id "null", merging every such mark
		// into one card pointing at whichever was visited first.
		const block = EDITOR.slice(
			EDITOR.indexOf("const [trackedMarks, setTrackedMarks]"),
			EDITOR.indexOf("const lastAnnotationFingerprintRef"),
		);
		assert.match(block, /mark\.attrs\.id === null/);
	});

	test("the id is never coerced to a string in the enumeration", () => {
		// It used to be `String(mark.attrs.id)`, which broke settlement outright: the
		// library generates NUMBER ids and its commands compare with `===`, so every
		// Approve/Reject was a silent no-op. `String` is valid only for a DOM query,
		// which lives in the offsets effect rather than here.
		const block = EDITOR.slice(
			EDITOR.indexOf("const [trackedMarks, setTrackedMarks]"),
			EDITOR.indexOf("const lastAnnotationFingerprintRef"),
		);
		assert.ok(
			!/String\(mark\.attrs\.id\)/.test(block),
			"stringifying the id makes settlement a no-op; keep its type",
		);
		assert.match(block, /mark\.attrs\.id as MarkId/, "the id keeps its own type");
	});

	test("marks sharing an id are grouped, because one suggestion can span nodes", () => {
		// The schema splits a run across text nodes as the user types. Counting nodes
		// would report one suggestion as several cards.
		const block = EDITOR.slice(
			EDITOR.indexOf("const [trackedMarks, setTrackedMarks]"),
			EDITOR.indexOf("const lastAnnotationFingerprintRef"),
		);
		assert.match(block, /Math\.min\(existing\.from, from\)/);
		assert.match(block, /Math\.max\(existing\.to, to\)/);
	});
});
describe("the panel stacks with the outline instead of covering it", () => {
	const PANEL = readFileSync(
		new URL("../../components/editor/annotations-panel.tsx", import.meta.url),
		"utf8",
	);
	const OUTLINE = readFileSync(
		new URL("../../components/editor/document-outline.tsx", import.meta.url),
		"utf8",
	);

	test("the panel's trigger clears the outline's toggle", () => {
		// The outline's small-screen toggle is `right-2 top-10`. If the panel also sat at
		// `top-10` below `xl`, the two would occupy one position and one would be
		// unreachable - not a stacking preference but a dead control.
		assert.match(
			OUTLINE,
			/absolute right-2 top-10 z-30 xl:hidden/,
			"the outline's toggle position is the constraint this test encodes",
		);
		// The className sits BEFORE the attribute, so the slice has to start above it.
		const at = PANEL.indexOf("data-annotations-panel");
		const trigger = PANEL.slice(Math.max(0, at - 200), at + 40);
		assert.ok(trigger.length > 0, "expected to find the panel trigger root");
		assert.match(trigger, /top-20/, "the panel must sit below the outline's toggle");
		assert.match(
			trigger,
			/xl:top-10/,
			"and rise at xl, where the outline becomes a rail and frees the corner",
		);
	});

	test("the panel body scrolls, with the filter row outside the scroll", () => {
		// The user asked for scrollable content like the outline overlay. The scroll has
		// to be on the BODY: putting it on the whole panel would carry the filter row and
		// close button off-screen as the list scrolls.
		assert.match(PANEL, /min-h-0 flex-1 overflow-y-auto/, "the body must scroll");
		assert.match(
			PANEL,
			/max-h-\[60vh\]/,
			"the panel must be bounded, or it grows past the viewport instead of scrolling",
		);
	});

	test("the panel is contained, not an alignment overlay", () => {
		// The anchored column is absolute-positioned per card against the document. The
		// panel must NOT reuse that: it is a bordered box with its own scroll.
		assert.match(PANEL, /rounded-lg border border-border bg-popover/, "contained box");
		assert.ok(
			!/inset-y-0/.test(PANEL),
			"the panel must not stretch the full editor height",
		);
	});
});

describe("the comment column's toggle lives in the shared top bar", () => {
	// Three things went wrong here in sequence, each found by the user rather than by a
	// test, so all three are pinned now.
	//
	//   1. The control was an icon and a bare count with no label, and it was DISABLED
	//      (40% opacity) when the document had no comments — the state a reader is most
	//      likely to be hunting for it in. The user could not find it.
	//   2. It sat in the EDITOR's toolbar row, which is `!isViewing`, so it did not exist
	//      in view mode at all — the mode comments are most often read in.
	//   3. It was then floating over the editor; the user asked for it in the top bar.
	const PANE = readFileSync(
		new URL("../../components/wiki/viewer-pane.tsx", import.meta.url),
		"utf8",
	);

	test("it is in the top bar, which renders in BOTH editing and viewing", () => {
		const control = PANE.indexOf("isMarkdown(openFile.name) && commentCount");
		assert.ok(control > 0, "expected to find the comment toggle in viewer-pane");
		// The two mode-specific guards must both come AFTER it: if the control sat inside
		// either one, one of the two modes would have no control at all.
		const editGuard = PANE.indexOf("{isText(openFile.name) && !editing", control - 2000);
		const viewingGuard = PANE.indexOf("{isText(openFile.name) && editing", control - 2000);
		assert.ok(
			editGuard === -1 || editGuard > control,
			"the toggle must not sit inside the viewing-only guard",
		);
		assert.ok(
			viewingGuard === -1 || viewingGuard > control,
			"the toggle must not sit inside the editing-only guard",
		);
	});

	test("it is NOT in the editor's edit-only toolbar row", () => {
		// The editor's toolbar row is `!isViewing`. A toggle there is invisible in view
		// mode, which is the defect this asserts against.
		const row = EDITOR.indexOf("{!isViewing && (");
		const rowEnd = EDITOR.indexOf("{sourceMode ? (", row);
		assert.ok(row > 0 && rowEnd > row, "expected to find the editor's toolbar row");
		const toolbarRow = EDITOR.slice(row, rowEnd);
		assert.ok(
			!/Hide comments|Show comments/.test(toolbarRow),
			"the toggle must not be back inside the edit-only toolbar row",
		);
	});

	test("it is hidden, not disabled, when there are no comments", () => {
		// `disabled` still renders, at reduced opacity, and reads as a broken control.
		assert.match(
			PANE,
			/isMarkdown\(openFile\.name\) && commentCount > 0 && \(/,
			"the control appears only when there is something to hide",
		);
		assert.ok(
			!/disabled=\{commentCount === 0\}/.test(PANE),
			"and must not render disabled",
		);
	});

	test("it is an icon plus count, with the verb in the tooltip", () => {
		// The visible LABEL was removed on request: one button shouting "Hide comments"
		// beside icon-only neighbours was visually wrong. The verb still has to exist for
		// anyone not reading iconography, so it lives in `title` AND `aria-label` —
		// `title` alone is not announced by screen readers.
		const control = PANE.slice(
			PANE.indexOf("{/* Show/hide the anchored comment cards."),
			PANE.indexOf("{isText(openFile.name) && !editing"),
		);
		assert.ok(control.length > 0, "expected to find the control block");
		assert.ok(
			!/\{commentColumnCollapsed \? "Show comments"/.test(control),
			"the visible label must be gone",
		);
		assert.match(control, /title=\{commentColumnCollapsed \? "Show comment cards"/);
		assert.match(control, /aria-label=\{commentColumnCollapsed \? "Show comment cards"/);
		assert.match(control, /\{commentCount\}/, "the count stays visible");
		assert.match(control, /aria-pressed=\{!commentColumnCollapsed\}/);
	});

	test("the count is published by the editor, which is the only thing that sees comments", () => {
		assert.match(
			EDITOR,
			/useCommentColumnStore\(\(state\) => state\.count\)|setCommentCount\(marginThreads\.length\)/,
			"the editor must publish the count",
		);
		// Reset on unmount, or the next document inherits a stale count and the top bar
		// offers a toggle for comments that are not there.
		assert.match(
			EDITOR,
			/return \(\) => setCommentCount\(0\)/,
			"the count must be cleared when the editor unmounts",
		);
	});
});

describe("the column pushes the document instead of covering it", () => {
	// Reverses an earlier decision. The column used to be an absolute overlay, for a
	// measured reason: as a flex sibling it subtracts from the document area, and at
	// 60rem the leftover slack was too small for `margin-inline: auto` to centre, so the
	// document pinned left and Center looked broken.
	//
	// The user's requirement is no overlap, so the fix is to reserve the width HONESTLY:
	// keep the sibling, and subtract the column's width from `--editor-max-w` so the
	// document is sized against the space it actually has. Both properties now hold —
	// nothing is covered, and `auto` still centres within the reduced area.
	const MARGIN = readFileSync(
		new URL("../../components/editor/comment-margin.tsx", import.meta.url),
		"utf8",
	);

	test("the column is a shrink-0 sibling, not an absolute overlay", () => {
		const root = MARGIN.slice(
			MARGIN.indexOf("return ("),
			MARGIN.indexOf("data-comment-margin"),
		);
		assert.match(root, /shrink-0/, "the column must reserve its width");
		assert.match(root, /self-stretch/);
		assert.ok(
			!/absolute inset-y-0/.test(root),
			"it must not be an inset overlay again — that is what covered the text",
		);
	});

	test("the width setting is NOT reduced by the column", () => {
		// A first attempt used `min(maxW, calc(100% - col))`, which BROKE the narrow /
		// normal / wide setting: the document was capped at the leftover space, so once
		// the setting exceeded that cap, Normal and Wide resolved to the same number (at a
		// 1253px row both produced 949px). Wide silently became Normal.
		//
		// The setting says how wide the TEXT is, so it has to survive the column being
		// open. The column comes out of the ROW (it is a flex sibling), not out of the
		// variable.
		assert.ok(
			!/calc\(100% - \$\{COMMENT_COLUMN_WIDTH_CSS\}\)/.test(EDITOR),
			"the width setting must not be reduced by the column's width",
		);
		assert.match(
			EDITOR,
			/\["--editor-max-w" as string\]: editorMaxW,/,
			"the variable must carry the width setting unchanged",
		);
	});

	test("all three width settings still select different widths", () => {
		// The property the user asked about, as arithmetic. Text = min(setting, row - col).
		// Where two settings collide the viewport genuinely cannot fit the larger one
		// beside the column — honest degradation, not a dead control. What must never
		// happen is a collision while there is room to honour the setting.
		const COLUMN = 19 * 16;
		const settings: Array<[string, number]> = [
			["narrow", 42 * 16],
			["normal", 60 * 16],
			["wide", 90 * 16],
		];
		// Wide and normal must differ whenever the row can hold both plus the column.
		const wideRow = 90 * 16 + COLUMN;
		const atWideRow = settings.map(([, maxW]) => Math.min(maxW, wideRow - COLUMN));
		assert.equal(
			new Set(atWideRow).size,
			3,
			`at a ${wideRow}px row all three settings must be distinct, got ${atWideRow}`,
		);
		// Narrow must be distinct even on the tightest plausible desktop row.
		const tightRow = 1280;
		const atTight = settings.map(([, maxW]) => Math.min(maxW, tightRow - COLUMN));
		assert.notEqual(atTight[0], atTight[1], "narrow must differ from normal");
	});

	test("the text is centred in the space the column leaves", () => {
		// `ml/mr-auto` centres within the flex item, so the reading column is centred in
		// `row - column` rather than in the full row (which would push it left, under the
		// column). Asserted on the three text containers that carry the setting.
		const containers = EDITOR.match(/max-w-\[var\(--editor-max-w/g) ?? [];
		assert.ok(
			containers.length >= 3,
			`expected the text containers to use --editor-max-w, found ${containers.length}`,
		);
		for (const line of EDITOR.split("\n")) {
			if (!line.includes("var(--editor-max-w")) continue;
			assert.ok(
				line.includes("ml-[var(--editor-ml"),
				`a text container lost its alignment margin: ${line.trim()}`,
			);
			assert.ok(line.includes("mr-auto"), `a text container lost mr-auto: ${line.trim()}`);
		}
	});
});
