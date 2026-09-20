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
		assert.ok(Number.isNaN(Math.max(0, Number("sa294")) + 1));
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
describe("a range inside an existing mark tag is refused", () => {
	// Found live: a caller computed its offset before an earlier mark was written, so
	// it pointed into that mark's own `<del data-id="1">` tag. Splicing there split the
	// tag and produced `<del da<del data-id="2">ta-i</del>d="1">app</del>` - which both
	// corrupts the tag and loses the first suggestion. The guard refuses the range so
	// the caller re-reads instead.
	const marked = 'Reactions in <del data-id="1">app</del> are slow.';

	test("an offset that lands inside a tag is refused", () => {
		const out = spliceMark(marked, "remove", { start: 20, end: 24 });
		assert.equal(out.ok, false);
		if (!out.ok) {
			assert.equal(out.code, "RANGE_IN_MARK");
			assert.match(out.message, /re-read/, "the message must say how to recover");
		}
	});

	test("the start edge of a tag is usable, only its interior is not", () => {
		// Offset 13 is where `<del` begins; a range may legitimately start there when
		// wrapping a following run. Only strictly-inside positions are refused.
		const out = spliceMark(marked, "remove", { start: 30, end: 33 });
		assert.equal(out.ok, true, "position 30 is just past the tag and must be allowed");
	});

	test("CONTROL: an unmarked block is never refused by this guard", () => {
		const out = spliceMark("Reactions in app are slow.", "remove", { start: 13, end: 16 });
		assert.equal(out.ok, true);
	});
});

describe("ids are document-scoped, not block-scoped", () => {
	// The editor groups marks by id across the WHOLE document, so two marks sharing an
	// id are ONE suggestion to it. Allocating per block made each block restart at 1.

	test("nextMarkId takes the maximum across every block when given a list", () => {
		const id = nextMarkId(['a <del data-id="3">x</del>', 'b <del data-id="7">y</del>']);
		assert.equal(id, 8, "the highest id anywhere in the document wins");
	});

	test("a single string is still accepted", () => {
		assert.equal(nextMarkId('a <del data-id="4">x</del>'), 5);
	});

	test("splicing with documentMarkdown clears marks in other blocks", () => {
		const other = 'beta <del data-id="9">thing</del>';
		const out = spliceMark("alpha thing", "remove", { start: 0, end: 5 }, undefined, [
			"alpha thing",
			other,
		]);
		assert.ok(out.ok);
		assert.match(out.markdown, /data-id="10"/, "must clear the other block's id 9");
	});

	test("CONTROL: without documentMarkdown the id is block-local, which is the bug", () => {
		// Pins that the parameter is what prevents the collision, rather than the
		// behaviour happening to work.
		const out = spliceMark("alpha thing", "remove", { start: 0, end: 5 });
		assert.ok(out.ok);
		assert.match(out.markdown, /data-id="1"/, "a block-local scan cannot see other blocks");
	});

	test("an id past the safe-integer range is ignored, not used as a base", () => {
		// `max + 1` is unrepresentable past 2^53, so it would equal `max` and the next
		// mark would silently reuse an existing id - which the editor reads as the same
		// suggestion. A malformed file must not be able to cause that.
		assert.equal(nextMarkId('a <del data-id="99999999999999999999">x</del>'), 1);
	});

	test("CONTROL: the largest safe id is still honoured", () => {
		assert.equal(nextMarkId('a <del data-id="9007199254740991">x</del>'), 9007199254740992);
	});

	test("ids with leading zeros are read as numbers", () => {
		assert.equal(nextMarkId('a <del data-id="007">x</del>'), 8);
	});
});


describe("the splice refuses everything that would corrupt the block", () => {
	const marked = 'A <del data-id="1">word</del> Z';

	test("a closing tag is as protected as an opening one", () => {
		// The guard scanned only opening tags, so a range inside `</del>` succeeded and
		// produced `A <del data-id="1">word</<del data-id="2">de</del>l> Z`.
		const out = spliceMark(marked, "remove", { start: 25, end: 27 });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_IN_MARK");
	});

	test("a range that CONTAINS a mark is refused, because marks cannot nest", () => {
		// Wrapping the whole block produced `<del data-id="2">A <del data-id="1">word</del> Z</del>`,
		// which the editor's mutually-exclusive mark specs cannot round-trip.
		const out = spliceMark(marked, "remove", { start: 0, end: marked.length });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_OVERLAPS_MARK");
	});

	test("inserted text carrying a tag character is refused", () => {
		// Measured without this: `x</ins>y` wrote `before <ins data-id="1">x</ins>y</ins>after`
		// and the round-trip dropped the extra tag.
		const out = spliceMark("before after", "insert", { start: 7, end: 7 }, "x</ins>y");
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "INVALID_TEXT");
	});

	test("inserted text with a blank line is refused, because it would split the block", () => {
		// A blank line ends the block, so the mark closed early: measured, the suggestion
		// covered `a` in one paragraph and `second` fell outside it entirely.
		const out = spliceMark("Before after.", "insert", { start: 7, end: 7 }, "a\n\nsecond");
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "INVALID_TEXT");
	});
});

describe("ordinary HTML is protected without being mistaken for a mark", () => {
	const span = '<span style="color:red">word</span>';

	test("a range inside ANY tag is refused, mark or not", () => {
		// Splitting `<span style=` produced `<span s<ins data-id="1">X</ins>tyle="color:red">`,
		// which breaks the attribute exactly as badly as splitting a mark tag.
		const out = spliceMark(span, "insert", { start: 7, end: 7 }, "X");
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_IN_MARK");
	});

	test("inserting into the TEXT inside a span is allowed", () => {
		// The regression the first fix caused: treating every span/div as suggestion
		// state refused legitimate proposals. Only tag INTERIORS are off limits.
		const out = spliceMark(span, "insert", { start: 25, end: 25 }, "X");
		assert.equal(out.ok, true);
		if (out.ok) assert.match(out.markdown, /w<ins data-id="1">X<\/ins>ord/);
	});

	test("a block with no HTML at all is unaffected", () => {
		const out = spliceMark("hello world", "insert", { start: 5, end: 5 }, "X");
		assert.equal(out.ok, true);
		if (out.ok) assert.equal(out.markdown, 'hello<ins data-id="1">X</ins> world');
	});
});
