import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPromptFromAnnotations,
	extractTaggedElement,
	mapAnnotationsToPromptItems,
	mapMarkSuggestionsToPromptItems,
	type PromptItem,
	type PromptSuggestion,
} from "../../lib/proof/prompt-serialize";

function suggestion(
	kind: PromptSuggestion["kind"],
	status: string = "pending",
	markdown?: string,
	baseMarkdown?: string,
): PromptSuggestion {
	return {
		ref: "b456",
		kind,
		status,
		markdown,
		baseMarkdown,
	};
}

/** Pull the JSON payload out of a built prompt, so tests assert on data, not prose. */
function payloadOf(prompt: string): { file: string; annotations: Array<Record<string, unknown>> } {
	const start = prompt.indexOf("\n{");
	assert.ok(start >= 0, "prompt carries a JSON payload");
	// The payload is pretty-printed, so its matching close brace is the one at
	// column 0. The mark legend, when present, follows it.
	const end = prompt.indexOf("\n}", start);
	assert.ok(end >= 0, "payload is closed");
	return JSON.parse(prompt.slice(start + 1, end + 2)) as { file: string; annotations: Array<Record<string, unknown>> };
}

const resolver = (annotation: { ref?: string; lineAnchor?: { lineStart: number; lineEnd: number } }) =>
	annotation.lineAnchor
		? { text: "The anchored paragraph text", lineStart: annotation.lineAnchor.lineStart, lineEnd: annotation.lineAnchor.lineEnd }
		: annotation.ref === "b456"
			? { text: "The current paragraph text", lineStart: 7, lineEnd: 7 }
			: { text: "The original paragraph text", lineStart: 42, lineEnd: 42 };

test("names the file and the exact replacements an agent must make", () => {
	const prompt = buildPromptFromAnnotations("notes/readme.md", [
		{ kind: "comment", blockText: "The paragraph being discussed", text: "Clarify this paragraph" },
		{
			kind: "suggestion",
			blockText: "The current paragraph",
			suggestionKind: "remove",
			proposed: "unclear",
			sourceMatch: '<del data-id="2">unclear</del>',
		},
	]);

	assert.match(prompt, /^Edit the file `notes\/readme\.md` using the annotations below\./);
	const { file, annotations } = payloadOf(prompt);
	assert.equal(file, "notes/readme.md");
	assert.equal(annotations.length, 2);
	assert.equal(annotations[1].operation, "delete");
	assert.equal(annotations[1].text, "unclear");
	assert.equal(annotations[1].source_match, '<del data-id="2">unclear</del>');
	assert.equal(annotations[1].replacement, "", "a deletion replaces its element with nothing");
});

test("serializes every reply, preserving by prefixes", () => {
	const items = mapAnnotationsToPromptItems([
		{
			ref: "b123",
			turns: [
				{ by: "human", text: "Original ask" },
				{ by: "ai:claude", text: "First reply" },
				{ by: "human", text: "Follow-up" },
			],
		},
	], [], resolver);
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", items));
	assert.equal(annotations[0].comment, "Original ask");
	assert.deepEqual(annotations[0].replies, [
		{ by: "ai:claude", text: "First reply" },
		{ by: "human", text: "Follow-up" },
	]);
});

test("a comment without a selection quotes its block verbatim, uncapped", () => {
	// The block is the comment's only locator when nothing was selected: capping it
	// would name a window an agent cannot match against the file.
	const longText = "a".repeat(240);
	const [item] = mapAnnotationsToPromptItems([{ ref: "long", text: "note" }], [], () => ({ text: longText }));
	assert.equal(item.blockText, longText);
	assert.equal(item.text, "note");
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", [item]));
	assert.equal(annotations[0].block, longText, "no cap, no ellipsis");
	assert.equal(annotations[0].selected_text, undefined);
});

test("a comment with a selection locates by selected_text, block becomes context", () => {
	// `selected_text` is the comment's counterpart of a suggestion's `source_match`:
	// the exact commented words, searchable in the file. The block is then context
	// only and gets capped — a 5 KB block must not repeat per comment.
	const longBlock = `${"context ".repeat(40)}TARGET ${"more ".repeat(40)}`;
	const [item] = mapAnnotationsToPromptItems(
		[{ ref: "b1", text: "what about this?", textAnchor: { start: 300, end: 306, selectedText: "TARGET" } }],
		[],
		() => ({ text: longBlock }),
	);
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", [item]));
	assert.equal(annotations[0].selected_text, "TARGET");
	assert.equal(annotations[0].block, `${capPrefix(longBlock)}…`, "capped context, not the whole block");
	assert.ok((annotations[0].block as string).length < longBlock.length);
});

// Mirrors capBlockText's 200-char rule; kept here so the test states its expectation
// without reaching into the module's private helper.
function capPrefix(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.slice(0, 199).trimEnd();
}

test("keeps non-mark suggestion kinds expressed in the record", () => {
	const items = mapAnnotationsToPromptItems([], [
		suggestion("replace", "pending", "replacement", "old text"),
		suggestion("delete"),
	], resolver);
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", items));
	assert.equal(annotations[0].operation, "replace");
	assert.equal(annotations[0].text, "replacement");
	assert.equal(annotations[1].operation, "delete");
});

test("maps open comments and pending suggestions only", () => {
	const items = mapAnnotationsToPromptItems(
		[
			{ ref: "b123", resolved: false, text: "Keep this request" },
			{ ref: "b999", resolved: true, text: "Resolved" },
			// A lost anchor has no text to quote, so it is not actionable.
			{ ref: "b111", text: "Lost anchor", anchorStatus: "lost" },
		],
		[suggestion("replace", "pending", "replacement"), suggestion("replace", "accepted", "done")],
		resolver,
	);
	assert.deepEqual(items.map((item) => item.text), ["Keep this request", undefined]);
	assert.deepEqual(items.map((item) => item.kind), ["comment", "suggestion"]);
});

test("excludes routed instructions and resolved plain comments", () => {
	const routedStates = ["queued", "sent", "answered"] as const;
	const items = mapAnnotationsToPromptItems([
		{ ref: "draft", kind: "instruction", instructionState: "draft", text: "Draft" },
		...routedStates.map((instructionState) => ({ ref: instructionState, kind: "instruction" as const, instructionState, text: instructionState })),
		{ ref: "resolved", resolved: true, text: "Resolved" },
		{ ref: "open", resolved: false, text: "Open" },
	]);
	assert.deepEqual(items.map((item) => item.text), ["Draft", "Open"]);
	assert.deepEqual(items.map((item) => item.kind), ["instruction", "comment"]);
});

test("still serializes an empty set as a usable instruction", () => {
	const prompt = buildPromptFromAnnotations("empty.md", []);
	assert.match(prompt, /^Edit the file `empty\.md` using the annotations below\./);
	assert.deepEqual(payloadOf(prompt).annotations, []);
	assert.deepEqual(mapAnnotationsToPromptItems([], []), []);
});

test("maps tracked marks into records naming the payload and the file element", () => {
	const items = mapMarkSuggestionsToPromptItems([
		{
			kind: "insert",
			text: "Added words",
			blockText: 'Kept <ins data-id="7">Added words</ins>',
			sourceMatch: '<ins data-id="7">Added words</ins>',
		},
		{
			kind: "remove",
			text: "Gone words",
			blockText: 'Kept <del data-id="3">Gone words</del>',
			sourceMatch: '<del data-id="3">Gone words</del>',
		},
	]);

	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", items));
	// No `block` on these: `source_match` is the locator, so the truncated block
	// would be repeated noise.
	assert.deepEqual(annotations[0], {
		id: 1,
		kind: "suggestion",
		operation: "insert",
		text: "Added words",
		source_match: '<ins data-id="7">Added words</ins>',
		replacement: "Added words",
	});
	assert.deepEqual(annotations[1], {
		id: 2,
		kind: "suggestion",
		operation: "delete",
		text: "Gone words",
		source_match: '<del data-id="3">Gone words</del>',
		replacement: "",
	});
});

test("describes attribute modifications with their before and after", () => {
	const items = mapMarkSuggestionsToPromptItems([
		{ kind: "modify", text: "", blockText: "A heading", attrName: "level", previousValue: 2, newValue: 3 },
		{ kind: "modify", text: "", attrName: "language", previousValue: null, newValue: "ts" },
	]);
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", items));
	assert.equal(annotations[0].operation, "modify");
	assert.equal(annotations[0].block, "A heading");
	assert.equal(annotations[0].from, 2);
	assert.equal(annotations[0].to, 3);
	assert.equal(annotations[1].from, null);
	assert.equal(annotations[1].to, "ts");
});

test("omits the mark legend when no mark-based suggestion is present", () => {
	const comment = buildPromptFromAnnotations("doc.md", mapAnnotationsToPromptItems([{ ref: "b1", text: "note" }]));
	assert.equal(comment.includes("Mark legend"), false);
	const legacy = buildPromptFromAnnotations("doc.md", mapAnnotationsToPromptItems([], [suggestion("replace", "pending", "replacement")]));
	assert.equal(legacy.includes("Mark legend"), false);
});

test("extractTaggedElement returns the file's exact element for an id", () => {
	// The live shape: one block carrying several suggestions. The whole point of
	// source_match is that each record quotes ITS OWN element, so an agent replaces
	// the right one without parsing tags to work out which is its target.
	const block =
		'1. Non-product surveys 2. Reactions in <del data-id="6">app</del> 2. Input - w<del data-id="1">hat\'s</del> r<del data-id="2">eal</del>? 3. School<ins data-id="5">asd</ins>';
	assert.equal(extractTaggedElement(block, "del", 6), '<del data-id="6">app</del>');
	assert.equal(extractTaggedElement(block, "del", 1), '<del data-id="1">hat\'s</del>');
	assert.equal(extractTaggedElement(block, "del", 2), '<del data-id="2">eal</del>');
	assert.equal(extractTaggedElement(block, "ins", 5), '<ins data-id="5">asd</ins>');
	// A mark the file does not carry cannot be exported.
	assert.equal(extractTaggedElement(block, "del", 99), undefined);
});

test("every saved mark in one block gets a distinct, self-identifying record", () => {
	// The regression this whole format exists for: six suggestions in one block used
	// to produce six near-identical truncated anchors, each saying only "apply this
	// suggested deletion" — no way to tell which tag was the target.
	const block =
		'1. Non-product surveys 2. Reactions in <del data-id="6">app</del> 2. Input - w<del data-id="1">hat\'s</del> r<del data-id="2">eal</del>? 3. Collect <del data-id="3">info:</del> 1. Maj<del data-id="4">ors?</del> 2. School<ins data-id="5">asd</ins> 3. Job 4. LLM to test';
	const marks = [6, 1, 2, 3, 4].map((id) => ({
		kind: "remove" as const,
		text: "x",
		blockText: block,
		sourceMatch: extractTaggedElement(block, "del", id),
	}));
	marks.push({
		kind: "insert" as const,
		text: "asd",
		blockText: block,
		sourceMatch: extractTaggedElement(block, "ins", 5),
	} as never);

	const { annotations } = payloadOf(buildPromptFromAnnotations("test.md", mapMarkSuggestionsToPromptItems(marks)));
	assert.equal(annotations.length, 6);
	const matches = annotations.map((a) => a.source_match);
	assert.equal(new Set(matches).size, 6, "no two records share a source_match");
	for (const a of annotations) {
		assert.ok(typeof a.source_match === "string" && a.source_match.length > 0, "record names its own element");
	}
	assert.deepEqual(matches, [
		'<del data-id="6">app</del>',
		'<del data-id="1">hat\'s</del>',
		'<del data-id="2">eal</del>',
		'<del data-id="3">info:</del>',
		'<del data-id="4">ors?</del>',
		'<ins data-id="5">asd</ins>',
	]);
});

test("excludes suggestions that are not in the saved file", () => {
	// Copy-as-prompt exports the SAVED file. An unsaved mark has no element on disk,
	// so exporting it would hand the agent an instruction with no target.
	const items: PromptItem[] = [
		// Mark-derived, but its tag was not found in the saved file: editor-only state.
		{ kind: "suggestion", suggestionKind: "insert", blockText: "The block on disk", proposed: "Fresh words", embedded: false },
		{
			kind: "suggestion",
			suggestionKind: "insert",
			blockText: 'Kept <ins data-id="7">Saved</ins>',
			proposed: "Saved",
			sourceMatch: '<ins data-id="7">Saved</ins>',
			embedded: true,
		},
	];
	const { annotations } = payloadOf(buildPromptFromAnnotations("doc.md", items));
	assert.equal(annotations.length, 1);
	assert.equal(annotations[0].source_match, '<ins data-id="7">Saved</ins>');
});

test("escapes quotes and angle brackets so the payload stays valid JSON", () => {
	// The payloads are document text, so they contain the same characters as the
	// markup. JSON's own escaping is what keeps this unambiguous.
	const items: PromptItem[] = [
		{
			kind: "suggestion",
			suggestionKind: "insert",
			blockText: 'before <ins data-id="9">he said "hi"</ins>',
			proposed: 'he said "hi"',
			sourceMatch: '<ins data-id="9">he said "hi"</ins>',
		},
	];
	const prompt = buildPromptFromAnnotations("doc.md", items);
	const { annotations } = payloadOf(prompt);
	assert.equal(annotations[0].text, 'he said "hi"');
	assert.equal(annotations[0].source_match, '<ins data-id="9">he said "hi"</ins>');
	assert.ok(prompt.includes('\\"hi\\"'), "quotes are escaped in the serialized text");
});