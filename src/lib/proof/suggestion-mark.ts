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
	code: "RANGE_OUT_OF_BOUNDS" | "EMPTY_RANGE" | "RANGE_IN_MARK";
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
			if (Number.isFinite(n) && n > max) max = n;
		}
	}
	return max + 1;
}

/**
 * Whether a position falls inside an existing mark tag rather than in visible text.
 *
 * `range` is an offset into the block markdown the caller read, and inserting a mark
 * changes those offsets. A caller that computed its offset BEFORE an earlier mark was
 * written therefore points into that mark's own `<del data-id="1">` tag, and splicing
 * there splits the tag: measured, it produced
 * `\<del da<del data-id="2">ta-i</del>d="1">app</del>`, which corrupts the tag AND
 * loses the first suggestion.
 *
 * A range that lands inside a tag is never intended, so it is refused. The caller's
 * own offsets are the thing that is stale, and it re-reads and retries.
 */
function insideMarkTag(markdown: string, pos: number): boolean {
	const re = /<(?:ins|del|span|div)[^>]*>/g;
	for (const match of markdown.matchAll(re)) {
		const start = match.index;
		const end = start + match[0].length;
		// Inside the tag's own text, but not before it and not after it.
		if (pos > start && pos < end) return true;
	}
	return false;
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
	// A stale offset would split an existing mark's tag in half. Refuse rather than
	// corrupt: nothing a caller means to propose lands inside a tag.
	if (insideMarkTag(markdown, start) || insideMarkTag(markdown, end)) {
		return {
			ok: false,
			code: "RANGE_IN_MARK",
			message:
				`range ${start}..${end} falls inside an existing mark tag. The range is ` +
				`an offset into the block's markdown, so it must be recomputed after any ` +
				`mark is added: re-read the block and retry.`,
		};
	}

	const id = nextMarkId(
		documentMarkdown === undefined ? markdown : [markdown, ...(typeof documentMarkdown === "string" ? [documentMarkdown] : documentMarkdown)],
	);
	const before = markdown.slice(0, start);
	const middle = start === end ? (text ?? "") : markdown.slice(start, end);
	const after = markdown.slice(end);
	const tag = kind === "remove" ? "del" : "ins";

	return { ok: true, markdown: `${before}<${tag} data-id="${id}">${middle}</${tag}>${after}` };
}