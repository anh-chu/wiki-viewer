import assert from "node:assert/strict";
import { test } from "node:test";
import { diffWords } from "../../lib/proof/word-diff.js";

test("returns one equal part for identical text", () => {
	assert.deepEqual(diffWords("same words", "same words"), [
		{ text: "same words", type: "equal" },
	]);
});

test("marks a pure insertion", () => {
	assert.deepEqual(diffWords("one two", "one new two"), [
		{ text: "one ", type: "equal" },
		{ text: "new ", type: "insert" },
		{ text: "two", type: "equal" },
	]);
});

test("marks a pure deletion", () => {
	assert.deepEqual(diffWords("one old two", "one two"), [
		{ text: "one ", type: "equal" },
		{ text: "old ", type: "delete" },
		{ text: "two", type: "equal" },
	]);
});

test("handles mixed replacements", () => {
	assert.deepEqual(diffWords("The old fox", "A new fox"), [
		{ text: "The", type: "delete" },
		{ text: "A", type: "insert" },
		{ text: " ", type: "equal" },
		{ text: "old", type: "delete" },
		{ text: "new", type: "insert" },
		{ text: " fox", type: "equal" },
	]);
});

test("handles empty sides", () => {
	assert.deepEqual(diffWords("", "added words"), [
		{ text: "added words", type: "insert" },
	]);
	assert.deepEqual(diffWords("removed words", ""), [
		{ text: "removed words", type: "delete" },
	]);
	assert.deepEqual(diffWords("", ""), []);
});

test("keeps punctuation and whitespace visible", () => {
	assert.deepEqual(diffWords("Hello, world!", "Hello world?"), [
		{ text: "Hello", type: "equal" },
		{ text: ",", type: "delete" },
		{ text: " world", type: "equal" },
		{ text: "!", type: "delete" },
		{ text: "?", type: "insert" },
	]);
	assert.deepEqual(diffWords("a  b", "a b"), [
		{ text: "a", type: "equal" },
		{ text: "  ", type: "delete" },
		{ text: " ", type: "insert" },
		{ text: "b", type: "equal" },
	]);
});
