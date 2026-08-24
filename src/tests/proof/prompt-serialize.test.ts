import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPromptFromAnnotations,
	mapAnnotationsToPromptItems,
	type PromptItem,
} from "../../lib/proof/prompt-serialize";
import type { Suggestion } from "../../lib/proof/types";

function suggestion(
	kind: Suggestion["kind"],
	status: Suggestion["status"] = "pending",
	markdown?: string,
): Suggestion {
	return {
		id: `s-${kind}`,
		ref: "b456",
		kind,
		status,
		by: "human",
		markdown,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

test("builds exact prompt format and numbers items from one", () => {
	const items: PromptItem[] = [
		{ snippet: "b123", kind: "comment", text: "Clarify this paragraph" },
		{
			snippet: "b456",
			kind: "suggestion",
			suggestionKind: "replace",
			proposed: "A clearer paragraph.",
		},
	];

	assert.equal(
		buildPromptFromAnnotations("notes/readme.md", items),
		"Edit the file `notes/readme.md` (a Markdown document). Apply these changes:\n\n1. `b123`: Clarify this paragraph\n2. `b456`: replace with \"A clearer paragraph.\"",
	);
});

test("uses kind-appropriate suggestion phrasing", () => {
	const items = mapAnnotationsToPromptItems([], [
		suggestion("replace", "pending", "replacement"),
		suggestion("insertAfter", "pending", "after"),
		suggestion("insertBefore", "pending", "before"),
		suggestion("delete"),
	]);

	assert.equal(
		buildPromptFromAnnotations("doc.md", items),
		[
			"Edit the file `doc.md` (a Markdown document). Apply these changes:",
			"",
			"1. `b456`: replace with \"replacement\"",
			"2. `b456`: insert \"after\"",
			"3. `b456`: insert \"before\"",
			"4. `b456`: delete this",
		].join("\n"),
	);
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

	assert.deepEqual(items, [
		{ snippet: "b123", kind: "comment", text: "Keep this request" },
		{ snippet: "lines 4-6", kind: "comment", text: "Use the line anchor" },
		{
			snippet: "b456",
			kind: "suggestion",
			proposed: "keep this",
			suggestionKind: "replace",
		},
	]);
});

test("serializes empty item sets with no numbered changes", () => {
	assert.equal(
		buildPromptFromAnnotations("empty.md", []),
		"Edit the file `empty.md` (a Markdown document). Apply these changes:\n",
	);
	assert.deepEqual(mapAnnotationsToPromptItems([], []), []);
});
