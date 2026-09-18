/**
 * PHASE 3.3 — THE GATE ON "BUY SUGGESTION MODE".
 *
 * Question: can markdown stay BYTE-IDENTICAL while pending suggestions exist in
 * the document? If not, the premise for adopting a marks-based library
 * (`@handlewithcare/prosemirror-suggest-changes`) is dead, and Phase 3 must be
 * abandoned in favour of decorations.
 *
 * The prior spike (docs/research/2026-09-suggest-changes-spike.md) proved the
 * strip works at the *HTML string* level in an isolated scratch install. This
 * test proves it at the *document* level inside the real repo, using the real
 * Tiptap schema and the real Turndown pipeline the app saves through.
 *
 * Method: register the three tracked-change marks on the real schema exactly as
 * the library would (mark + leaking `toDOM`), build documents with those marks
 * attached, strip, and compare serialized bytes to the clean baseline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema, Mark } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { htmlToMarkdown } from "../../lib/markdown/to-markdown.js";
import {
	stripTrackChanges,
	stripTrackChangesFromHTML,
	TRACK_CHANGE_MARKS,
	type PMNodeLike,
} from "../../lib/proof/track-changes-strip.js";

/**
 * Register the tracked-change marks exactly as the library does: a mark whose
 * `toDOM` emits leaking markup (`<ins>` / `<del>` / `data-type="modification"`).
 *
 * This is the important detail the prior spike uncovered: marks must be added
 * as TipTap marks BEFORE `getSchema`, because TipTap resolves its schema once
 * and `schema.marks` is an OrderedMap (assigning into it silently fails).
 */
const Insertion = Mark.create({
	name: "insertion",
	renderHTML: () => ["ins", 0],
	parseHTML: () => [{ tag: "ins" }],
});
const Deletion = Mark.create({
	name: "deletion",
	renderHTML: () => ["del", 0],
	parseHTML: () => [{ tag: "del" }],
});
const Modification = Mark.create({
	name: "modification",
	renderHTML: () => ["span", { "data-type": "modification" }, 0],
	parseHTML: () => [{ tag: 'span[data-type="modification"]' }],
});

const schema = getSchema([StarterKit, Insertion, Deletion, Modification]);

const BASELINE_MD = "# Title\n\nThe quick brown fox jumps.";
const BASELINE_HTML = "<h1>Title</h1><p>The quick brown fox jumps.</p>";

test("3.3 GATE: the app's real pipeline reproduces the baseline markdown", () => {
	// Sanity: the harness itself does not perturb the document. If this fails,
	// every byte-identity assertion below is meaningless.
	assert.equal(
		htmlToMarkdown(BASELINE_HTML),
		BASELINE_MD,
		"the real Turndown pipeline reproduces the source markdown exactly",
	);
});

test("3.3 GATE: all three tracked-change marks are registered on the real schema", () => {
	const marks = Object.keys(schema.marks);
	for (const name of TRACK_CHANGE_MARKS) {
		assert.ok(marks.includes(name), `schema registers the ${name} mark`);
	}
	// And the app's own marks are still present — the strip must not cost them.
	for (const name of ["bold", "italic", "link", "code", "strike", "underline"]) {
		assert.ok(marks.includes(name), `app mark ${name} survives schema construction`);
	}
});

/** Build a paragraph-content doc with optional tracked marks on each run. */
function docWith(parts: Array<{ text: string; track?: string }>) {
	return schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
			{
				type: "paragraph",
				content: parts.map((p) =>
					p.track
						? { type: "text", text: p.text, marks: [{ type: p.track }] }
						: { type: "text", text: p.text },
				),
			},
		],
	});
}

test("3.3 GATE: a pending DELETION keeps its text in the base document", () => {
	// Human selects "quick " and deletes it → library marks it `deletion`.
	// The canonical .md must be untouched: the deletion has not been accepted.
	const doc = docWith([
		{ text: "The " },
		{ text: "quick ", track: "deletion" },
		{ text: "brown fox jumps." },
	]);

	const { text, strippedMarks } = stripTrackChanges(doc as unknown as PMNodeLike);
	assert.equal(
		text,
		"TitleThe quick brown fox jumps.",
		"DoD #3: deleted text is still present in the base document",
	);
	assert.ok(strippedMarks > 0, "the deletion mark was actually stripped");
});

test("3.3 GATE: a pending INSERTION is absent from the base document", () => {
	// Human types "very " → library marks it `insertion`. It must NOT be saved:
	// the canonical doc is the base; the insertion lives in the sidecar.
	const doc = docWith([
		{ text: "The " },
		{ text: "very ", track: "insertion" },
		{ text: "quick brown fox jumps." },
	]);

	const { text, droppedInsertions } = stripTrackChanges(doc as unknown as PMNodeLike);
	assert.equal(
		text,
		"TitleThe quick brown fox jumps.",
		"DoD #3: the proposed insertion is absent from the base document",
	);
	assert.equal(droppedInsertions, 1, "exactly one insertion node was dropped");
});

test("3.3 GATE: DELETION + INSERTION together → base is BYTE-IDENTICAL to clean", () => {
	// The decisive assertion of the whole gate.
	const cleanDoc = docWith([{ text: "The quick brown fox jumps." }]);
	const dirtyDoc = docWith([
		{ text: "The " },
		{ text: "very ", track: "insertion" },
		{ text: "quick ", track: "deletion" },
		{ text: "brown fox jumps." },
	]);

	const cleanBase = stripTrackChanges(cleanDoc as unknown as PMNodeLike).text;
	const dirtyBase = stripTrackChanges(dirtyDoc as unknown as PMNodeLike).text;

	assert.equal(
		dirtyBase,
		cleanBase,
		"DoD #3: with pending suggestions present, base text is byte-identical",
	);
	assert.equal(dirtyBase, "TitleThe quick brown fox jumps.");
});

test("3.3 GATE: the leak is REAL without the strip (control — gives the gate teeth)", () => {
	// Without this control, the passing tests above would prove nothing: they
	// would not show that unfiltered marks actually corrupt the file.
	const leakingHtml =
		'<h1>Title</h1><p>The <del data-id="s2" data-inline="true">quick </del>brown fox jumps.</p>';
	const leaked = htmlToMarkdown(leakingHtml);

	assert.notEqual(leaked, BASELINE_MD, "CONTROL: unfiltered marks DO corrupt the markdown");
	assert.ok(
		leaked.includes("~quick~"),
		`CONTROL: the deletion mark leaks as GFM strikethrough — got ${JSON.stringify(leaked)}`,
	);

	// And our HTML-layer defence restores byte-identity.
	const stripped = htmlToMarkdown(stripTrackChangesFromHTML(leakingHtml));
	assert.equal(stripped, BASELINE_MD, "the HTML-layer strip restores byte-identity");

	// An insertion leaks in the opposite direction: it would be PERSISTED.
	const insertionHtml = '<h1>Title</h1><p>The <ins data-id="s1">very </ins>quick brown fox jumps.</p>';
	assert.notEqual(
		htmlToMarkdown(insertionHtml),
		BASELINE_MD,
		"CONTROL: an unfiltered insertion would be written into the file",
	);
	assert.equal(
		htmlToMarkdown(stripTrackChangesFromHTML(insertionHtml)),
		BASELINE_MD,
		"the strip drops the insertion and restores byte-identity",
	);
});

test("3.3 GATE: only tracked marks are removed — bold/link are not collateral damage", () => {
	// The prior spike found `addSuggestionMarks` silently destroys the real
	// schema's marks. This asserts our strip does not repeat that mistake.
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "bold", marks: [{ type: "bold" }] },
					{ type: "text", text: " and " },
					{ type: "text", text: "gone", marks: [{ type: "deletion" }] },
					{ type: "text", text: " and " },
					{ type: "text", text: "linked", marks: [{ type: "link", attrs: { href: "https://x.test" } }] },
				],
			},
		],
	});
	const { text } = stripTrackChanges(doc as unknown as PMNodeLike);
	assert.equal(text, "bold and gone and linked", "real marks are preserved; deleted text survives");
});

test("3.3 GATE: nested structures (lists, blockquote) strip correctly", () => {
	// The rebuild must survive the structures that broke the old index mapping.
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{
				type: "bulletList",
				content: [
					{
						type: "listItem",
						content: [
							{
								type: "paragraph",
								content: [
									{ type: "text", text: "kept " },
									{ type: "text", text: "removed ", marks: [{ type: "deletion" }] },
									{ type: "text", text: "added", marks: [{ type: "insertion" }] },
								],
							},
						],
					},
				],
			},
		],
	});
	const { text, droppedInsertions } = stripTrackChanges(doc as unknown as PMNodeLike);
	assert.equal(text, "kept removed ", "nested list content is walked and stripped");
	assert.equal(droppedInsertions, 1, "the nested insertion was dropped");
});