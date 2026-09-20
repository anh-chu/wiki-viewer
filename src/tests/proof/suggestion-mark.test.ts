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

describe("declarations and raw-text elements are not tag-spliceable", () => {
	// The scanner originally found a declaration's end with `indexOf(">")`, which is
	// wrong for anything with a quoted interior, and treated a raw-text body as markup.

	test("a CDATA section is one span, `>` inside it included", () => {
		const out = spliceMark("<![CDATA[a>b]]>", "insert", { start: 12, end: 12 }, "X");
		assert.equal(out.ok, false);
	});

	test("a processing instruction ends at `?>`, not at a quoted `>`", () => {
		const out = spliceMark('<?x a=">">', "insert", { start: 8, end: 8 }, "X");
		assert.equal(out.ok, false);
	});

	test("a raw-text element body is one span, because its content is not markup", () => {
		// `<script>a>b</script>` at offset 9 looked safe and landed a mark inside code.
		for (const html of ["<script>a>b</script>", "<style>a>b</style>"]) {
			const out = spliceMark(html, "insert", { start: 9, end: 9 }, "X");
			assert.equal(out.ok, false, `${html} must not be spliceable inside its body`);
		}
	});

	test("CONTROL: ordinary prose is never refused by these rules", () => {
		const out = spliceMark("hello world", "insert", { start: 5, end: 5 }, "X");
		assert.equal(out.ok, true);
	});
});

describe("an insertion point on a mark's own edge is refused", () => {
	// An empty range is an insertion point, and the gap test needed `start < end`, so it
	// never fired for one: inserting exactly after `<del data-id="1">` nested a second,
	// mutually-exclusive mark inside the first.
	const marked = 'A <del data-id="1">word</del> Z';

	test("inserting just inside a mark's opening tag is refused", () => {
		const out = spliceMark(marked, "insert", { start: 19, end: 19 }, "X");
		assert.equal(out.ok, false);
	});

	test("inserting just inside a mark's closing tag is refused", () => {
		const out = spliceMark(marked, "insert", { start: 23, end: 23 }, "X");
		assert.equal(out.ok, false);
	});

	test("CONTROL: inserting beside a mark, clear of its tags, is allowed", () => {
		// The ordinary workflow: a second suggestion next to the first. These offsets are
		// outside the mark AND clear of its tag boundaries.
		for (const pos of [0, 1, 30, 31]) {
			const out = spliceMark(marked, "insert", { start: pos, end: pos }, "X");
			assert.equal(out.ok, true, `offset ${pos} is clear of the mark and its tags`);
		}
	});

	test("an insertion point INSIDE a mark's tags is refused", () => {
		// Offsets 3..28 are within the paired `<del>`/`</del>` tags: an insertion there
		// nests a second, mutually-exclusive mark inside the first.
		for (const pos of [3, 19, 23, 28]) {
			const out = spliceMark(marked, "insert", { start: pos, end: pos }, "X");
			assert.equal(out.ok, false, `offset ${pos} is inside the mark's tags`);
		}
	});

	test("an insertion point on a TERMINATED tag's end edge is allowed", () => {
		// The end edge of a tag that closed properly is where the next character begins,
		// so it is outside. Offset 2 (before `<del`) and 29 (right after `</del>`) both
		// belong to the surrounding text.
		for (const pos of [2, 29]) {
			const out = spliceMark(marked, "insert", { start: pos, end: pos }, "X");
			assert.equal(out.ok, true, `offset ${pos} is clear of the mark's text`);
		}
	});
});

describe("a raw-text body and an unterminated span are untouchable to the end", () => {
	test("a string literal holding `</script>` does not end the element early", () => {
		// Found by adversarial review. The span ended at the FIRST close tag, which here
		// is inside a JS string, so offset 31 spliced a mark into the script body - where
		// it is not markup - and the round-trip moved code around:
		// `const x = ""; <ins...>X</ins>alert(1);`.
		const script = '<script>const x = "</script>"; alert(1);</script>';
		const out = spliceMark(script, "insert", { start: 31, end: 31 }, "X");
		assert.equal(out.ok, false);
	});

	test("an UNTERMINATED span covers to the end of the block, insertion at EOF included", () => {
		// A zero-width insertion was tested with `start > span.start && start < span.end`,
		// so a point exactly at `span.end` counted as outside. For an unterminated span
		// that is the last offset in the block, and inserting there spliced into the
		// instruction: `<?x a=">" no close` round-tripped corrupted.
		for (const src of ['<?x a=">" no close', "before <!-- no close", '<a title="x tail']) {
			const out = spliceMark(src, "insert", { start: src.length, end: src.length }, "X");
			assert.equal(out.ok, false, `EOF of ${JSON.stringify(src)} is inside the span`);
		}
	});

	test("CONTROL: text after a properly closed element is still usable", () => {
		// The widened spans must not make a block with HTML uneditable.
		const out = spliceMark("<script>a</script> tail", "insert", { start: 22, end: 22 }, "X");
		assert.equal(out.ok, true, "text after the element must stay proposable");
	});
});

describe("raw-text elements: the body is refused, the boundaries are not", () => {
	test("a decoy close tag inside the body does not end the element early", () => {
		// The FIRST close tag here is inside a JS string, so treating it as the end of the
		// element let offset 31 (the start of `alert`) take a mark. Round-tripping that
		// produced `"; <ins...>X</ins>alert(1);` - the `const x = "` prefix was gone and
		// `alert(1)` had moved behind the mark.
		const script = '<script>const x = "</script>"; alert(1);</script>';
		const out = spliceMark(script, "insert", { start: 31, end: 31 }, "X");
		assert.equal(out.ok, false);
	});

	test("a decoy does not make one element swallow the rest of the block", () => {
		// Taking the LAST close tag outright was also wrong: on this input it made a
		// single span cover the whole block, so the text BETWEEN the two elements was
		// refused. The two cases together are why the rule has to tell a decoy from a
		// sibling element rather than just picking first or last.
		const two = "<script>a</script> <script>b</script>";
		assert.equal(spliceMark(two, "insert", { start: 18, end: 18 }, "X").ok, true);
		assert.equal(spliceMark(two, "insert", { start: 29, end: 29 }, "X").ok, false);
	});

	test("the boundaries of a raw-text element are usable", () => {
		for (const pos of [0, 18]) {
			const out = spliceMark("<script>a</script>", "insert", { start: pos, end: pos }, "X");
			assert.equal(out.ok, true, `offset ${pos} is outside the element`);
		}
	});

	test("an EMPTY raw-text body is untouchable inside", () => {
		const out = spliceMark("<script></script>", "insert", { start: 8, end: 8 }, "X");
		assert.equal(out.ok, false);
	});
});
