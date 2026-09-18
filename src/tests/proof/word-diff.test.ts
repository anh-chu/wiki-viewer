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

// ── Phase 2b invariants: the jsdiff swap must preserve the redline contract ──

test("P2b: equal+delete parts reconstruct the current text exactly", () => {
	// The redline applies offsets from these parts onto ProseMirror positions,
	// so the non-inserted parts must reproduce `current` byte-for-byte. A lost
	// or duplicated space here silently shifts every highlight after it.
	const cases: Array<[string, string]> = [
		["The quick brown fox", "The very quick brown fox"],
		["one  two   three", "one two three"],
		["a,b;c", "a, b; c"],
		["Ünïcödé wörds", "Ünïcödé wörds indeed"],
		["", "brand new"],
		["removed entirely", ""],
		["punctuation! and? more.", "punctuation! more."],
	];
	for (const [current, proposed] of cases) {
		const parts = diffWords(current, proposed);
		const reconstructed = parts
			.filter((p) => p.type !== "insert")
			.map((p) => p.text)
			.join("");
		assert.equal(
			reconstructed,
			current,
			`equal+delete must rebuild current exactly: ${JSON.stringify(current)} -> ${JSON.stringify(proposed)}`,
		);
	}
});

test("P2b: equal+insert parts reconstruct the proposed text exactly", () => {
	const cases: Array<[string, string]> = [
		["The quick brown fox", "The very quick brown fox"],
		["one  two", "one two"],
		["a", "a b c"],
		["drop this", ""],
	];
	for (const [current, proposed] of cases) {
		const parts = diffWords(current, proposed);
		const reconstructed = parts
			.filter((p) => p.type !== "delete")
			.map((p) => p.text)
			.join("");
		assert.equal(
			reconstructed,
			proposed,
			`equal+insert must rebuild proposed exactly: ${JSON.stringify(current)} -> ${JSON.stringify(proposed)}`,
		);
	}
});

test("P2b: adjacent parts of the same type are merged into one run", () => {
	// Consumers map one descriptor per part; unmerged runs would emit duplicate
	// overlapping decorations for a single visual change.
	for (const [current, proposed] of [
		["a b c d", "w x y z"],
		["The quick brown fox", "The slow red fox"],
	] as Array<[string, string]>) {
		const parts = diffWords(current, proposed);
		for (let i = 1; i < parts.length; i += 1) {
			assert.notEqual(
				parts[i].type,
				parts[i - 1].type,
				`adjacent ${parts[i].type} parts must be merged`,
			);
		}
	}
});

test("P2b: no empty parts are emitted", () => {
	for (const [current, proposed] of [
		["a", "b"],
		["", ""],
		["one two", "one two three"],
	] as Array<[string, string]>) {
		for (const part of diffWords(current, proposed)) {
			assert.ok(part.text.length > 0, "empty parts would create zero-width spans");
		}
	}
});
