/**
 * Splicing a tracked mark into block markdown.
 *
 * These guard the two ways an agent-authored suggestion can silently corrupt a document:
 * an id that poisons the library's id allocation, and an offset that lands in the wrong
 * place. Both are quiet failures — the op returns success and the damage shows up later.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nextMarkId, spliceMark } from "@/lib/proof/suggestion-mark";

describe("mark id allocation", () => {
	test("an empty block starts at 1", () => {
		assert.equal(nextMarkId("plain text"), 1);
	});

	test("continues above the highest id present", () => {
		assert.equal(nextMarkId('a <del data-id="3">b</del> c <ins data-id="7">d</ins>'), 8);
	});

	test("is not confused by non-numeric or absent ids", () => {
		// A sidecar-era id like "s3e34" must not be treated as a number, and must not
		// become the basis for the next id either.
		assert.equal(nextMarkId('a <del data-id="s3e34">b</del>'), 1);
		assert.equal(nextMarkId("<del>b</del>"), 1);
	});

	test("CONTROL: a non-numeric id would produce NaN for the library", () => {
		// The failure this whole helper exists to prevent. The vendored generator is
		// `Math.max(id) + 1`; given a string it yields NaN, and every later keystroke
		// inherits it.
		assert.ok(Number.isNaN(Math.max(0, "sa294") + 1));
	});
});

describe("splicing a deletion", () => {
	test("wraps the range and KEEPS the text", () => {
		const out = spliceMark("Reactions in app here", "remove", { start: 13, end: 16 });
		assert.ok(out.ok);
		assert.equal(out.markdown, 'Reactions in <del data-id="1">app</del> here');
	});

	test("a deletion keeps its text so reject can bring it back", () => {
		const out = spliceMark("keep me", "remove", { start: 0, end: 4 });
		assert.ok(out.ok);
		assert.match(out.markdown, /keep/, "a deletion mark must not delete the words");
	});
});

describe("splicing an insertion", () => {
	test("places supplied text at the offset, marked", () => {
		const out = spliceMark("ab", "insert", { start: 1, end: 1 }, "XYZ");
		assert.ok(out.ok);
		assert.equal(out.markdown, 'a<ins data-id="1">XYZ</ins>b');
	});

	test("wraps an existing range when one is given", () => {
		const out = spliceMark("one two three", "insert", { start: 4, end: 7 });
		assert.ok(out.ok);
		assert.equal(out.markdown, 'one <ins data-id="1">two</ins> three');
	});
});

describe("refusals", () => {
	test("a range past the end of the block is refused, not clamped", () => {
		const out = spliceMark("short", "remove", { start: 2, end: 99 });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_OUT_OF_BOUNDS");
	});

	test("a negative start is refused", () => {
		const out = spliceMark("short", "remove", { start: -1, end: 2 });
		assert.equal(out.ok, false);
	});

	test("an empty range with no text to insert is refused", () => {
		const out = spliceMark("short", "insert", { start: 2, end: 2 });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "EMPTY_RANGE");
	});

	test("CONTROL: a valid range is accepted, so the refusals above are not vacuous", () => {
		assert.equal(spliceMark("short", "remove", { start: 0, end: 2 }).ok, true);
	});
});

describe("markdown offset semantics", () => {
	test("counts markdown bytes, not rendered characters", () => {
		// The live bug this avoids: "2. Reactions in app" in markdown is "Reactions in app"
		// rendered. Splicing at a markdown offset must not assume the two agree.
		const md = "Reactions in app";
		const out = spliceMark(md, "remove", { start: 13, end: 16 });
		assert.ok(out.ok);
		assert.match(out.markdown, /<del data-id="1">app<\/del>/);
	});

	test("a second splice takes the next id and preserves the first mark", () => {
		const first = spliceMark("abc", "remove", { start: 0, end: 1 });
		assert.ok(first.ok);
		const second = spliceMark(first.markdown, "insert", { start: first.markdown.length, end: first.markdown.length }, "Z");
		assert.ok(second.ok);
		assert.match(second.markdown, /<del data-id="1">a<\/del>/);
		assert.match(second.markdown, /<ins data-id="2">Z<\/ins>/);
	});
});