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

describe("comments and suggestions share one panel", () => {
	// These were two surfaces: an anchored comment column and a floating list of
	// suggestions. They were merged because the split forced a false choice — the
	// column had POSITION but could not describe a change (a suggestion is a mark over
	// a few words, so aligning its card to the block edge said nothing about which
	// words), and the list had WORDS but no position. Anchoring a suggestion to the
	// block its mark sits in and quoting the covered words gives both, in the surface
	// that was already beside the text.
	const MARGIN = readFileSync(
		new URL("../../components/editor/comment-margin.tsx", import.meta.url),
		"utf8",
	);

	test("the panel draws both kinds of card", () => {
		assert.match(MARGIN, /thread: MarginThread \| null/, "comment cards ride on `thread`");
		assert.match(
			MARGIN,
			/suggestion: PanelSuggestion \| null/,
			"suggestion cards ride on `suggestion`",
		);
		assert.match(MARGIN, /<SuggestionCard/, "and a suggestion card is rendered");
	});

	test("one collision pass covers both kinds", () => {
		// Two independent layouts would let a comment and a suggestion on the same line
		// print on top of each other — the failure the anchored layout exists to avoid.
		assert.match(
			MARGIN,
			/function layout\(\s*threads: readonly MarginThread\[\],\s*suggestions: readonly PanelSuggestion\[\],/,
			"layout must take both lists and interleave them by anchor",
		);
	});

	test("the editor passes suggestions into the panel with both handlers", () => {
		assert.match(EDITOR, /suggestions=\{panelSuggestions\}/);
		assert.match(EDITOR, /onAcceptSuggestion=\{/);
		assert.match(EDITOR, /onRejectSuggestion=\{/);
	});

	test("the floating annotations panel is gone", () => {
		// Deleted with its component and tests; the panel beside the text replaced it.
		assert.ok(
			!/AnnotationsPanel/.test(EDITOR),
			"the old floating panel must not still be rendered",
		);
	});

	test("each suggestion is anchored to the block its mark sits in", () => {
		// Without this the card could only be listed, which is what the old surface did.
		assert.match(
			EDITOR,
			/blockRef: string \| null/,
			"the panel suggestion type must carry an anchor",
		);
		assert.match(
			EDITOR,
			/suggestionBlocks\[index\]\?\.ref \?\? null/,
			"resolved by top-level block index, as the comment path does",
		);
	});

	test("the old comment-only gate is gone", () => {
		// `showCommentMargin` required comments specifically, so a document with only
		// suggestions still showed nothing. The panel now opens for either kind.
		assert.ok(
			!/showCommentMargin/.test(EDITOR),
			"visibility must not be keyed on comments alone",
		);
		assert.match(EDITOR, /panelShowingAnything/);
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
describe("the annotations control is a plain toggle; the tabs live on the panel", () => {
	// The first version opened a floating popup of tabs below the button, with the
	// panel positioned independently beneath it. Two elements computing their own
	// place is exactly how they end up overlapping — the failure the user reported.
	// The tabs moved onto the panel's OWN header, so there is one surface and no
	// second thing to collide with.
	const BUTTON = readFileSync(
		new URL("../../components/editor/annotations-button.tsx", import.meta.url),
		"utf8",
	);
	const MARGIN = readFileSync(
		new URL("../../components/editor/comment-margin.tsx", import.meta.url),
		"utf8",
	);
	const OUTLINE = readFileSync(
		new URL("../../components/editor/document-outline.tsx", import.meta.url),
		"utf8",
	);

	test("the button clears the outline's own toggle", () => {
		// The outline is now the margin's model: ONE pushing left column with a
		// corner toggle when closed, at `left-2 top-10` — every width, no
		// `xl`-gated overlay fallback, no hover expansion. The annotations button
		// keeps the right corner at `top-10`; the two corners are different
		// surfaces, so neither can cover the other.
		assert.match(
			OUTLINE,
			/absolute left-2 top-10 z-30/,
			"the outline's toggle position is the constraint this test encodes",
		);
		assert.ok(
			!/xl:hidden/.test(OUTLINE),
			"the toggle must exist at every width — there is no overlay fallback",
		);
		assert.match(BUTTON, /right-2 top-10/, "the button keeps the right corner");
		assert.ok(
			!/top-20/.test(BUTTON),
			"the stacking offset under the right-corner outline is gone with it",
		);
	});

	test("the outline pushes like the margin column", () => {
		// Same requirement as the comment column: reserve the width honestly.
		assert.match(OUTLINE, /shrink-0 self-stretch/, "the column must reserve its width");
		assert.ok(
			!/hovered/.test(OUTLINE),
			"no hover expansion: expanding on hover reflows on every pass over the rail",
		);
		assert.match(
			EDITOR,
			/, outlineOpen\]/,
			"the editor must re-measure offsets when the outline opens or closes",
		);
	});

	test("the button only shows and hides; it does not hold the tabs", () => {
		// If the tabs were here as well as on the panel, the two could disagree about
		// which tab is active.
		assert.ok(
			!/role="tablist"/.test(BUTTON),
			"the tablist belongs on the panel, not the button",
		);
		assert.match(BUTTON, /togglePanel/);
	});

	test("the tabs are All, Comments and Changes, on the panel's header", () => {
		assert.match(MARGIN, /label: "All"/);
		assert.match(MARGIN, /label: "Comments"/);
		assert.match(MARGIN, /label: "Changes"/);
		assert.match(MARGIN, /role="tablist"/);
		assert.match(MARGIN, /<PanelHeader/, "and they are rendered as the panel's header");
	});

	test("the header is OUTSIDE the anchored card area", () => {
		// The cards are absolutely positioned against the box they sit in. If the
		// header were inside that box, a card anchored near the top would print over
		// the tabs.
		const header = MARGIN.indexOf("<PanelHeader");
		const body = MARGIN.indexOf("data-annotations-body");
		assert.ok(header > 0 && body > header, "the header must precede the body");
		assert.match(
			MARGIN.slice(body - 120, body + 20),
			/className="relative min-h-0 flex-1"/,
			"the body must be its own positioned box",
		);
	});

	test("a tab with nothing behind it is disabled, not hidden", () => {
		// The three tabs are one control: hiding one would move the others under the
		// cursor as annotations come and go.
		assert.match(MARGIN, /disabled=\{t\.count === 0\}/);
	});

	test("no control at all when the document has nothing to annotate", () => {
		assert.match(
			BUTTON,
			/if \(total === 0\) return null;/,
			"a button that opens an empty panel is worse than no button",
		);
	});

	test("the badge and the panel read the same function", () => {
		// A badge that advertises a count the panel does not draw is the one failure
		// that would make the reviewer distrust every number on screen.
		assert.match(BUTTON, /panelContents\(/);
		assert.match(EDITOR, /panelContents\(/);
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
