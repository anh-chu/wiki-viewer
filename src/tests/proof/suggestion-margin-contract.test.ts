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

describe("the column shows pending suggestions", () => {
	test("marginSuggestions is built from the document's marks", () => {
		const block = EDITOR.slice(
			EDITOR.indexOf("const marginSuggestions = useMemo("),
			EDITOR.indexOf("const showCommentMargin ="),
		);
		assert.ok(block.length > 0, "expected to find the marginSuggestions memo");
		assert.match(
			block,
			/trackedMarks\.map/,
			"the card list must come from the enumerated marks, not a store",
		);
	});

	test("the column is shown when there are suggestions even with no comments", () => {
		// The regression: keying visibility on comments alone means a document whose only
		// annotation is a suggestion shows no column, so the suggestion cannot be
		// approved at all.
		const block = EDITOR.slice(
			EDITOR.indexOf("const showCommentMargin ="),
			EDITOR.indexOf("const showCommentMargin =") + 200,
		);
		assert.match(block, /marginThreads\.length > 0/);
		assert.match(
			block,
			/marginSuggestions\.length > 0/,
			"suggestions alone must be enough to show the column",
		);
	});

	test("the cards are passed to the margin with both handlers", () => {
		assert.match(EDITOR, /suggestions=\{marginSuggestions\}/);
		assert.match(EDITOR, /onAcceptSuggestion=/);
		assert.match(EDITOR, /onRejectSuggestion=/);
	});

	test("the margin renders a card for a suggestion item, not just for a thread", () => {
		// `layout` returns both kinds, and the render branches on the key. A render that
		// skipped the threadless entries would drop every suggestion card silently.
		assert.match(MARGIN, /<SuggestionMarginCard/);
		assert.match(
			MARGIN,
			/key\.startsWith\("suggestion:"\)/,
			"the render must distinguish a suggestion entry from a thread entry",
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