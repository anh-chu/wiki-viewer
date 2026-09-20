/**
 * Splice a tracked-change mark into block markdown.
 *
 * A suggestion is a ProseMirror mark, and the `.md` file is the source of truth for it:
 * `<del data-id="6">app</del>`, `<ins data-id="5">asd</ins>`. An agent proposing an edit
 * writes the same markup a human produces by typing in Suggesting mode, so both authors
 * land in one representation with one review surface. Nothing here is a second store.
 *
 * OFFSETS ARE MARKDOWN OFFSETS, deliberately. `range` arrives from the caller in block
 * markdown coordinates, which is the coordinate system the block ops already use. Mapping
 * to rendered ProseMirror positions and back is what produced the live "Reactions "
 * highlight bug: a list item's markdown carries a `1. ` prefix its rendered node does not,
 * so the two systems cannot be converted by arithmetic. Splicing the markdown string
 * needs no conversion at all, and the editor re-parses the result.
 *
 * The mark is spliced as literal HTML because markdown has no syntax for a suggestion,
 * and raw HTML is this codebase's established way to carry state markdown cannot express
 * (`to-markdown.ts` preserves `ins`/`del` on the way out and `sanitize-schema.ts` keeps
 * `dataId` on the way in). Both halves are pinned by `suggestion-roundtrip.test.ts`.
 */

/** The three tracked mark kinds, matching the vendored library's mark names. */
export type MarkKind = "insert" | "remove";

export interface SpliceResult {
	ok: true;
	/** Block markdown with the mark applied. */
	markdown: string;
}

export interface SpliceFailure {
	ok: false;
	code:
		| "RANGE_OUT_OF_BOUNDS"
		| "EMPTY_RANGE"
		| "RANGE_IN_MARK"
		| "RANGE_OVERLAPS_MARK"
		| "INVALID_TEXT";
	message: string;
}

/**
 * The `data-id` a new mark should carry.
 *
 * Ids must be NUMERIC and strictly above every id already in the block. The vendored
 * library allocates ids with `Math.max(existing) + 1` (`generateId.js`), so two things
 * break otherwise:
 *
 *   - A non-numeric id makes that `Math.max` return `NaN`, which then propagates: every
 *     subsequent human keystroke gets `id: NaN` and all their suggestions merge into one.
 *     Measured: `Math.max(0, "sa294") + 1 === NaN`.
 *   - Reusing an id already present merges the agent's mark with whatever the human types
 *     next, because the library treats id as suggestion identity.
 *
 * Scanning for the raw `data-id="N"` is correct here and does not need a parse: the ids
 * only ever appear inside a mark tag, and a mark tag only appears as HTML.
 */
export function nextMarkId(markdown: string | readonly string[]): number {
	let max = 0;
	const re = /data-id="(\d+)"/g;
	// Accepts the whole document as well as a single block, because ids are
	// DOCUMENT-scoped: the editor groups marks by id across the entire document, so
	// two marks sharing an id are one suggestion to it. Scanning only the block being
	// edited made two blocks each start at 1 - measured, that produced
	// `<del data-id="1">alpha</del>` and `<del data-id="1">beta</del>` in one write,
	// which the editor then collapsed into a single card whose Accept settled both.
	const sources = typeof markdown === "string" ? [markdown] : markdown;
	for (const source of sources) {
		for (const match of source.matchAll(re)) {
			const n = Number.parseInt(match[1], 10);
			// `Number.isSafeInteger` matters, not just finiteness: an id past 2^53
			// (a malformed or hand-edited file could carry one) makes `max + 1`
			// unrepresentable and silently equal to `max`, so the next mark would reuse
			// an existing id and the editor would merge the two suggestions. Ignoring
			// such a value keeps allocation correct for every realistic document.
			if (Number.isSafeInteger(n) && n > max) max = n;
		}
	}
	return max + 1;
}

/**
 * Every mark tag in the block, as `[start, end)` spans over the markdown.
 *
 * Only ACTUAL mark tags count for the NESTING rules. Matching every `<span>`/`<div>`
 * mistook ordinary raw HTML for suggestion state, so a legitimate proposal inside
 * `<span style="color:red">` was refused as `RANGE_IN_MARK`. A tag qualifies only by
 * being one of the two elements the editor writes with a `data-id`: `ins` and `del`,
 * open or close.
 */
function markTagSpans(markdown: string): { start: number; end: number }[] {
	const re = /<\/?(?:ins|del)\b[^>]*>/g;
	return [...markdown.matchAll(re)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

/**
 * Every HTML tag in the block, mark or not.
 *
 * Splicing anywhere inside a tag splits it, whatever the tag is. This is not specific
 * to suggestions: placing text at offset 7 of `<span style="color:red">word</span>`
 * produces `<span s<ins data-id="1">X</ins>tyle="color:red">`, which breaks the span's
 * attribute just as badly as the original bug broke a `<del data-id>`. So the
 * "not inside a tag" rule applies to all tags, while the nesting rules apply only to
 * marks.
 */
function anyTagSpans(markdown: string): { start: number; end: number }[] {
	const re = /<\/?[a-zA-Z][^>]*>/g;
	return [...markdown.matchAll(re)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
	}));
}

/** Whether `pos` falls strictly inside a mark tag. */
function insideMarkTag(spans: readonly { start: number; end: number }[], pos: number): boolean {
	return spans.some((span) => pos > span.start && pos < span.end);
}

/**
 * Wrap `markdown[start..end)` in a tracked mark, or wrap the range's text in a deletion
 * for `remove`.
 *
 * `remove` keeps the text inside the mark rather than cutting it: that is the whole point
 * of a deletion mark over a delete, since rejecting has to be able to bring the words
 * back. Accepting removes it.
 *
 * `insert` has no text of its own to wrap when the caller supplies `text`; the inserted
 * text is placed at `start` and marked. When `end > start` the existing range is wrapped
 * instead, which is how a proposal to rewrite existing words is expressed.
 */
export function spliceMark(
	markdown: string,
	kind: MarkKind,
	range: { start: number; end: number },
	text?: string,
	/**
	 * Every mark already in the DOCUMENT, so the new id clears all of them.
	 *
	 * Ids are document-scoped because that is how the editor groups them. Passing only
	 * this block's markdown is a bug when the document has more than one: each block
	 * would restart at 1 and the editor would merge the marks into one suggestion.
	 * Omitted only where a single value is genuinely the whole scope.
	 */
	documentMarkdown?: string | readonly string[],
): SpliceResult | SpliceFailure {
	const { start, end } = range;
	if (!Number.isInteger(start) || !Number.isInteger(end)) {
		return { ok: false, code: "EMPTY_RANGE", message: "range must be integers" };
	}
	if (start < 0 || end > markdown.length || start > end) {
		return {
			ok: false,
			code: "RANGE_OUT_OF_BOUNDS",
			message: `range ${start}..${end} is outside the block (length ${markdown.length})`,
		};
	}
	if (start === end && !text) {
		return {
			ok: false,
			code: "EMPTY_RANGE",
			message: "an empty range needs text to insert",
		};
	}
	const spans = markTagSpans(markdown);

	// A stale offset would split an existing tag in half. Refuse rather than corrupt:
	// nothing a caller means to propose lands inside a tag. Both ENDS are checked
	// because the range is a slice, and both OPEN and CLOSE tags count - `</del>` is as
	// much a tag as `<del ...>`, and splitting it corrupts the block. This covers
	// ordinary HTML too, since any split tag is broken regardless of what it is.
	const tags = anyTagSpans(markdown);
	if (insideMarkTag(tags, start) || insideMarkTag(tags, end)) {
		return {
			ok: false,
			code: "RANGE_IN_MARK",
			message:
				`range ${start}..${end} falls inside an HTML tag. The range is ` +
				`an offset into the block's markdown, so it must be recomputed after any ` +
				`mark is added: re-read the block and retry.`,
		};
	}

	// A range that CONTAINS a tag would wrap an existing mark in a new one, producing
	// nested marks of the same kind. ProseMirror's mark specs declare `ins`/`del`
	// mutually exclusive, so that nesting cannot round-trip: it either drops the inner
	// mark or fails to parse, and the outer mark's text silently changes. Refuse and
	// make the caller propose against plain text.
	const enclosing = spans.find((span) => span.start > start && span.end <= end);
	if (enclosing) {
		return {
			ok: false,
			code: "RANGE_OVERLAPS_MARK",
			message:
				`range ${start}..${end} contains an existing mark (at ${enclosing.start}). ` +
				`Marks cannot nest, so a range must cover plain text only: re-read the ` +
				`block and propose against the text the mark does not already cover.`,
		};
	}

	// Text the caller supplies is spliced as RAW HTML into the block, so it must not be
	// able to close the tag it is placed in or open another one. Measured without this:
	// inserting `x</ins>y` wrote `before <ins data-id="1">x</ins>y</ins>after`, and
	// round-tripping dropped the second `</ins>` and merged `y` into the text.
	if (text !== undefined && /[<>]/.test(text)) {
		return {
			ok: false,
			code: "INVALID_TEXT",
			message:
				`suggested text must not contain < or >: it is spliced as raw HTML, so a ` +
				`tag character would break the mark it is placed in.`,
		};
	}

	const id = nextMarkId(
		documentMarkdown === undefined ? markdown : [markdown, ...(typeof documentMarkdown === "string" ? [documentMarkdown] : documentMarkdown)],
	);
	const before = markdown.slice(0, start);
	const middle = start === end ? (text ?? "") : markdown.slice(start, end);
	const after = markdown.slice(end);
	const tag = kind === "remove" ? "del" : "ins";

	// A blank line inside a mark ends the BLOCK in markdown, so the mark would close at
	// the paragraph boundary and the rest of its text would fall outside it. Measured:
	// inserting `a\n\nsecond` produced a mark the snapshot split into
	// `Before <ins data-id="1">a` and `second</ins>after.`, and after a round-trip
	// `second` was not part of the suggestion at all. A mark covers inline text, so it
	// cannot span a paragraph break.
	if (/\n[ \t]*\n/.test(middle)) {
		return {
			ok: false,
			code: "INVALID_TEXT",
			message:
				`the marked text would contain a blank line, which ends the block in ` +
				`markdown and would split the mark across two paragraphs. A mark covers ` +
				`inline text only.`,
		};
	}

	return { ok: true, markdown: `${before}<${tag} data-id="${id}">${middle}</${tag}>${after}` };
}
/**
 * A suggestion mark's id, keeping the type the vendored library uses.
 *
 * The library GENERATES numbers (`generateNextNumberId` returns `suggestionId + 1`)
 * and its settle commands compare with strict equality:
 * `mark.attrs["id"] === suggestionId`. A mark round-trips its id through
 * `JSON.stringify` in `toDOM` and `JSON.parse` in `parseDOM`, so a numeric id stays a
 * number across a save and reload.
 *
 * Stringifying for convenience therefore breaks settlement silently: the command
 * matches nothing, dispatches no transaction, and the card stays on screen while the
 * button appears to do nothing. Keep the original type.
 */
export type MarkId = number | string;
