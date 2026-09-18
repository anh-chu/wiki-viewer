/**
 * PHASE 2 acceptance — exact-text comment anchors (DoD #1) and recovery (DoD #6).
 *
 * Complements repro-comment-range.test.ts (which pins the missing capability)
 * by exercising the real locate/verify/search path against real ProseMirror
 * documents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
	locateCommentAnchor,
	mapCommentDecorations,
	blockPositionsFromDoc,
} from "../../lib/proof/comment-decorator.js";
import type { Comment } from "../../lib/proof/types.js";

const schema = getSchema([StarterKit]);

function docWithParagraphs(texts: string[]) {
	return schema.nodeFromJSON({
		type: "doc",
		content: texts.map((t) => ({
			type: "paragraph",
			content: t ? [{ type: "text", text: t }] : [],
		})),
	});
}

test("P2: an anchored comment resolves to the exact commented words", () => {
	const text = "The quick brown fox";
	const outcome = locateCommentAnchor(
		{ start: 4, end: 15, selectedText: "quick brown" },
		text,
	);
	assert.equal(outcome.status, "exact");
	assert.equal(text.slice(outcome.from, outcome.to), "quick brown");
});

test("P2: offsets that drifted are recovered by searching the stored text", () => {
	// The text moved right by 10 chars; the old offsets no longer match.
	const text = "Well, then the quick brown fox";
	const outcome = locateCommentAnchor(
		{ start: 4, end: 15, selectedText: "quick brown" },
		text,
	);
	assert.equal(outcome.status, "recovered", "DoD #6: the anchor is re-found, not lost");
	assert.equal(text.slice(outcome.from, outcome.to), "quick brown");
});

test("P2: a repeated phrase re-anchors to the nearest occurrence", () => {
	// "the cat" appears twice. The user commented on the SECOND one.
	const text = "the cat sat; later the cat left";
	const second = text.lastIndexOf("the cat");
	const outcome = locateCommentAnchor(
		{ start: second, end: second + 7, selectedText: "the cat" },
		"", // force the search path
	);
	assert.equal(outcome.status, "orphaned", "empty block text cannot resolve");

	const recovered = locateCommentAnchor(
		{ start: second, end: second + 7, selectedText: "the cat" },
		`X ${text}`, // shifts everything by 2, invalidating the stored offsets
	);
	assert.equal(recovered.status, "recovered");
	assert.equal(
		recovered.from,
		second + 2,
		"the nearer occurrence wins, not the first in the document",
	);
});

test("P2: text that no longer exists is reported orphaned, never silently mis-placed", () => {
	const outcome = locateCommentAnchor(
		{ start: 0, end: 11, selectedText: "quick brown" },
		"Completely different sentence.",
	);
	assert.equal(outcome.status, "orphaned");
	assert.equal(outcome.status === "orphaned" && outcome.reason, "text-not-found");
});

test("P2: a block with no anchor produces no descriptor", () => {
	const doc = docWithParagraphs(["The quick brown fox", "Second para"]);
	const blocks = [
		{ ref: "b111111", markdown: "The quick brown fox" },
		{ ref: "b222222", markdown: "Second para" },
	];
	const positions = blockPositionsFromDoc(doc, blocks);

	const comments: Comment[] = [
		{
			id: "c0001",
			ref: "b111111",
			resolved: false,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "explain", at: "2026-09-18T00:00:00Z" }],
			// no textAnchor — legacy block-granular comment
		},
	];
	const descriptors = mapCommentDecorations(comments, positions);
	assert.equal(descriptors.length, 0, "a legacy comment yields no text highlight");
});

test("P2: a ranged comment produces a highlight spanning exactly the selection", () => {
	const doc = docWithParagraphs(["The quick brown fox", "Second para"]);
	const blocks = [
		{ ref: "b111111", markdown: "The quick brown fox" },
		{ ref: "b222222", markdown: "Second para" },
	];
	const positions = blockPositionsFromDoc(doc, blocks);

	const comments: Comment[] = [
		{
			id: "c0002",
			ref: "b111111",
			resolved: false,
			createdAt: "2026-09-18T00:00:00Z",
			turns: [{ by: "human", text: "explain", at: "2026-09-18T00:00:00Z" }],
			textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
		},
	];
	const [descriptor] = mapCommentDecorations(comments, positions);
	assert.ok(descriptor, "one descriptor");
	assert.equal(descriptor.text, "quick brown");
	assert.equal(descriptor.recovered, false, "resolved exactly, not by search");
	// contentStart = block.from + 1, so offsets shift by one.
	assert.equal(descriptor.to - descriptor.from, 11, "highlight length equals the selection");
});

test("P2: resolved and stale comments produce no highlight", () => {
	const doc = docWithParagraphs(["The quick brown fox"]);
	const blocks = [{ ref: "b111111", markdown: "The quick brown fox" }];
	const positions = blockPositionsFromDoc(doc, blocks);
	const base: Omit<Comment, "id" | "resolved"> = {
		ref: "b111111",
		createdAt: "2026-09-18T00:00:00Z",
		turns: [{ by: "human", text: "x", at: "2026-09-18T00:00:00Z" }],
		textAnchor: { start: 4, end: 15, selectedText: "quick brown" },
	};

	const resolved: Comment[] = [{ ...base, id: "c1", resolved: true }];
	assert.equal(mapCommentDecorations(resolved, positions).length, 0, "resolved → no highlight");

	const stale: Comment[] = [{ ...base, id: "c2", resolved: false, stale: true }];
	assert.equal(mapCommentDecorations(stale, positions).length, 0, "stale → no highlight");

	const live: Comment[] = [{ ...base, id: "c3", resolved: false }];
	assert.equal(mapCommentDecorations(live, positions).length, 1, "live → highlighted");
});