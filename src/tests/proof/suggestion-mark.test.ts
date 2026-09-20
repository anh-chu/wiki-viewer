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
		// Offset 20 is inside `<del data-id="1">`, which spans 13..30.
		const out = spliceMark(marked, "remove", { start: 20, end: 24 });
		assert.equal(out.ok, false);
		if (!out.ok) {
			// The range spans the tag's start, so containment reports it as an overlap
			// rather than an interior hit. Either code means "refused", which is the
			// property under test; the specific code is pinned by the boundary tests.
			assert.ok(
				out.code === "RANGE_IN_MARK" || out.code === "RANGE_OVERLAPS_MARK",
				`expected a refusal, got ${out.code}`,
			);
			assert.match(out.message, /re-read/i, "the message must say how to recover");
		}
	});

	test("the text a mark covers is refused, and plain text around it is not", () => {
		// The rule narrowed as the guard got stricter. A range over `app` (the mark's own
		// text, 30..33) nests one mark in another, so it is now refused rather than
		// allowed; text that the mark does not cover stays proposable.
		const insideText = spliceMark(marked, "remove", { start: 30, end: 33 });
		assert.equal(insideText.ok, false, "a mark's own text cannot take a second mark");

		const before = spliceMark(marked, "remove", { start: 0, end: 11 });
		assert.equal(before.ok, true, "unmarked text before the mark must stay proposable");
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
		// produced `A <del data-id="1">word</<del data-id="2">de</del>l> Z`. The code is
		// RANGE_OVERLAPS_MARK rather than RANGE_IN_MARK because containment, which is
		// what makes the exact-boundary cases safe too, reports it.
		const out = spliceMark(marked, "remove", { start: 25, end: 27 });
		assert.equal(out.ok, false);
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

describe("a range that lands exactly on a tag boundary is refused", () => {
	// Endpoint checks are not enough. These ranges touch no tag INTERIOR, so an
	// "is this position inside a tag" test passed them, yet each one crossed or nested
	// tags. Measured before containment: 2..23 produced
	// `A <ins data-id="2"><del data-id="1">word</ins></del> Z`.
	const marked = 'A <del data-id="1">word</del> Z';

	test("a range spanning from one tag boundary to another is refused", () => {
		const out = spliceMark(marked, "remove", { start: 2, end: 23 });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_OVERLAPS_MARK");
	});

	test("a range exactly covering a closing tag is refused", () => {
		const out = spliceMark(marked, "remove", { start: 23, end: 29 });
		assert.equal(out.ok, false);
	});

	test("a range over the TEXT a mark covers is refused, because marks cannot nest", () => {
		// Touches no tag at all - `word` is the mark's own text - so only an explicit
		// inside-the-mark test catches it. Nesting `<ins>` in `<del>` does not survive
		// the reload, since the schema declares them mutually exclusive.
		const out = spliceMark(marked, "remove", { start: 19, end: 23 });
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_OVERLAPS_MARK");
	});

	test("CONTROL: plain text AROUND a mark is still proposable", () => {
		// The rule must not make a block with one suggestion uneditable. This is the
		// ordinary multi-suggestion workflow: a second proposal beside the first.
		const before = spliceMark(marked, "remove", { start: 0, end: 1 });
		assert.equal(before.ok, true, "text before an existing mark must remain usable");
		const after = spliceMark(marked, "remove", { start: 30, end: 31 });
		assert.equal(after.ok, true, "and text after it");
	});
});

describe("HTML the regex could not parse is protected", () => {
	test("a range inside an HTML comment is refused", () => {
		// `<!-- secret -->` has no tag-like structure for a `[^>]*` pattern to respect.
		// Measured: the mark landed inside the comment and the round-trip deleted it.
		const out = spliceMark("a <!-- secret --> b", "insert", { start: 7, end: 7 }, "X");
		assert.equal(out.ok, false);
		if (!out.ok) assert.equal(out.code, "RANGE_IN_MARK");
	});

	test("a range inside a doctype or declaration is refused", () => {
		const out = spliceMark("<!DOCTYPE html>", "insert", { start: 3, end: 3 }, "X");
		assert.equal(out.ok, false);
	});

	test("a `>` inside a quoted attribute does not end the tag early", () => {
		// `<a title="a>b">` - a pattern stopping at the first `>` thinks the tag ends at
		// offset 12, so offset 12 looked safe. It is inside the attribute.
		const out = spliceMark('<a title="a>b">word</a>', "insert", { start: 12, end: 12 }, "X");
		assert.equal(out.ok, false);
	});

	test("a self-closing tag cannot be wrapped", () => {
		const out = spliceMark('a <img src="x" /> b', "insert", { start: 6, end: 6 }, "X");
		assert.equal(out.ok, false);
	});

	test("a literal `<` in prose is still text, not a tag", () => {
		// The guard must not over-reach: `a < b` has no tag, so the offset is legitimate.
		const out = spliceMark("a < b", "insert", { start: 1, end: 1 }, "X");
		assert.equal(out.ok, true, "a bare less-than is content");
	});
});
