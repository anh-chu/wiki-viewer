import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPromptFromAnnotations,
	mapAnnotationsToPromptItems,
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

const resolver = (annotation: { ref?: string; lineAnchor?: { lineStart: number; lineEnd: number } }) =>
	annotation.lineAnchor
		? { text: "The anchored paragraph text", lineStart: annotation.lineAnchor.lineStart, lineEnd: annotation.lineAnchor.lineEnd }
		: annotation.ref === "b456"
			? { text: "The current paragraph text", lineStart: 7, lineEnd: 7 }
			: { text: "The original paragraph text", lineStart: 42, lineEnd: 42 };

test("builds a locatable prompt and numbers items from one", () => {
	const items: PromptItem[] = [
		{
			kind: "comment",
			blockText: "The paragraph being discussed",
			lineStart: 42,
			text: "Clarify this paragraph",
			turns: [
				{ by: "human", text: "Clarify this paragraph" },
				{ by: "ai:claude", text: "I need more context" },
			],
		},
		{
			kind: "suggestion",
			blockText: "The current paragraph",
			lineStart: 7,
			suggestionKind: "replace",
			proposed: "A clearer paragraph.",
		},
	];

	assert.equal(
		buildPromptFromAnnotations("notes/readme.md", items),
		[
			"Edit the file `notes/readme.md` (a Markdown document). Apply these changes:",
			"",
			"1. Comment on paragraph \"The paragraph being discussed\" (line 42):",
			'   "Clarify this paragraph"',
			"   - ai:claude: I need more context",
			"2. Suggestion on \"The current paragraph\" (line 7): replace with",
			'   "A clearer paragraph."',
		].join("\n"),
	);
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
	assert.equal(
		buildPromptFromAnnotations("doc.md", items),
		[
			"Edit the file `doc.md` (a Markdown document). Apply these changes:",
			"",
			"1. Comment on paragraph \"The original paragraph text\" (line 42):",
			'   "Original ask"',
			"   - ai:claude: First reply",
			"   - human: Follow-up",
		].join("\n"),
	);
});

test("caps long block text with an ellipsis", () => {
	const longText = "a".repeat(240);
	const [item] = mapAnnotationsToPromptItems([{ ref: "long", text: "note" }], [], () => ({ text: longText }));
	assert.equal(item.blockText, longText);
	assert.equal(item.text, "note");
	assert.equal(buildPromptFromAnnotations("doc.md", [item]).includes(`${longText.slice(0, 199)}…`), true);
});

test("uses kind-appropriate suggestion phrasing and current text", () => {
	const items = mapAnnotationsToPromptItems([], [
		suggestion("replace", "pending", "replacement", "old text"),
		suggestion("insertAfter", "pending", "after"),
		suggestion("insertBefore", "pending", "before"),
		suggestion("delete"),
	], resolver);

	assert.deepEqual(items[0], {
		blockText: "The current paragraph text",
		lineStart: 7,
		lineEnd: 7,
		kind: "suggestion",
		proposed: "replacement",
		currentText: "old text",
		suggestionKind: "replace",
	});
	assert.match(buildPromptFromAnnotations("doc.md", items), /replace with/);
	assert.match(buildPromptFromAnnotations("doc.md", items), /insert after/);
	assert.match(buildPromptFromAnnotations("doc.md", items), /insert before/);
	assert.match(buildPromptFromAnnotations("doc.md", items), /delete this block/);
});

test("maps open comments and pending suggestions only", () => {
	const items = mapAnnotationsToPromptItems(
		[
			{ ref: "b123", resolved: false, text: "Keep this request" },
			{ ref: "b234", resolved: true, text: "Already resolved" },
			{
				lineAnchor: { lineStart: 4, lineEnd: 6, textHash: "abc123" },
				resolved: false,
				turns: [{ by: "human", text: "Use the line anchor" }],
			},
		],
		[
			suggestion("replace", "pending", "keep this"),
			suggestion("delete", "accepted"),
			suggestion("delete", "rejected"),
		],
	);

	assert.equal(items.length, 3);
	assert.equal(items[0].text, "Keep this request");
	assert.equal(items[0].blockText, undefined);
	assert.equal(items[1].snippet, "lines 4-6");
	assert.equal(items[1].lineStart, 4);
	assert.equal(items[1].lineEnd, 6);
	assert.equal(items[1].text, "Use the line anchor");
	assert.deepEqual(items[1].turns, [{ by: "human", text: "Use the line anchor" }]);
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

test("serializes empty item sets with no numbered changes", () => {
	assert.equal(
		buildPromptFromAnnotations("empty.md", []),
		"Edit the file `empty.md` (a Markdown document). Apply these changes:\n",
	);
	assert.deepEqual(mapAnnotationsToPromptItems([], []), []);
});
