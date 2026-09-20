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
 * Every tag-like span in the block, found by scanning rather than by pattern.
 *
 * A regex cannot decide where a tag ends. `<a title="a>b">` contains a `>` inside a
 * quoted attribute, and an HTML comment contains `<` and `>` that are not tags at all —
 * measured, a range placed inside `<!-- -->` or `<!DOCTYPE html>` passed a regex-based
 * guard and corrupted the block. So this walks the string, tracks whether it is inside
 * a quoted attribute value, and treats comments and doctypes as single spans.
 *
 * Returns each span with the element name and whether it is a closing tag, which is what
 * the nesting rules need; `tag` is null for comments and declarations.
 */
interface TagSpan {
	start: number;
	end: number;
	name: string | null;
	closing: boolean;
}

function scanTagSpans(markdown: string): TagSpan[] {
	const spans: TagSpan[] = [];
	let i = 0;
	while (i < markdown.length) {
		if (markdown[i] !== "<") {
			i += 1;
			continue;
		}
		// Comments and declarations run to their own terminator and are one span.
		if (markdown.startsWith("<!--", i)) {
			const close = markdown.indexOf("-->", i + 4);
			const end = close === -1 ? markdown.length : close + 3;
			spans.push({ start: i, end, name: null, closing: false });
			i = end;
			continue;
		}
		// CDATA and processing instructions have quoted/`>`-bearing interiors of their
		// own, so they cannot be found with `indexOf(">")`: in `<![CDATA[a>b]]>` that
		// finds the `>` inside the data and a splice at offset 12 landed inside the
		// section. Both end at their own delimiter.
		if (markdown.startsWith("<![CDATA[", i)) {
			const close = markdown.indexOf("]]>", i + 9);
			const end = close === -1 ? markdown.length : close + 3;
			spans.push({ start: i, end, name: null, closing: false });
			i = end;
			continue;
		}
		if (markdown[i + 1] === "?") {
			// `?>`; a `>` inside a quoted value does not end it.
			let j = i + 2;
			let q: string | null = null;
			while (j < markdown.length) {
				const ch = markdown[j];
				if (q) {
					if (ch === q) q = null;
				} else if (ch === '"' || ch === "'") {
					q = ch;
				} else if (ch === "?" && markdown[j + 1] === ">") {
					j += 2;
					break;
				}
				j += 1;
			}
			spans.push({ start: i, end: j, name: null, closing: false });
			i = j;
			continue;
		}
		if (markdown[i + 1] === "!") {
			// `<!DOCTYPE html>` and friends: quoted `>` still does not close them.
			let j = i + 2;
			let q: string | null = null;
			while (j < markdown.length) {
				const ch = markdown[j];
				if (q) {
					if (ch === q) q = null;
				} else if (ch === '"' || ch === "'") {
					q = ch;
				} else if (ch === ">") {
					j += 1;
					break;
				}
				j += 1;
			}
			spans.push({ start: i, end: j, name: null, closing: false });
			i = j;
			continue;
		}

		const closing = markdown[i + 1] === "/";
		const nameStart = i + (closing ? 2 : 1);
		const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(markdown.slice(nameStart));
		if (!nameMatch) {
			// A literal `<` in text, e.g. "a < b". Not a tag; leave it as content.
			i += 1;
			continue;
		}

		// Walk to the tag's real end, skipping `>` inside quoted attribute values.
		let j = nameStart + nameMatch[0].length;
		let quote: string | null = null;
		while (j < markdown.length) {
			const ch = markdown[j];
			if (quote) {
				if (ch === quote) quote = null;
			} else if (ch === '"' || ch === "'") {
				quote = ch;
			} else if (ch === ">") {
				j += 1;
				break;
			}
			j += 1;
		}
		const name = markdown.slice(nameStart, nameStart + nameMatch[0].length).toLowerCase();

		// A raw-text element's content is not markup - a `<script>` body can contain
		// `>` and even `</` - so the whole element is one span. Otherwise a splice
		// inside the body looks safe (`<script>a>b</script>` at offset 9) and lands in
		// code, where the tag is never parsed as a mark.
		if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
			// The body is opaque: it can contain `>`, `</`, and a string literal holding
			// a literal `</script>`. Taking the FIRST close tag is wrong for that last
			// case - measured on `<script>const x = "</script>"; alert(1);</script>` the
			// span ended at the string's `</script>`, so offset 31 spliced a mark into
			// the body and the round-trip moved code around.
			//
			// The LAST close tag is the safe choice: it can only ever mark MORE of the
			// block as untouchable, never less, so a splice inside the body is refused
			// in every case. Over-refusing here costs a caller a retry; under-refusing
			// corrupts the file.
			//
			// ponytail: a naively-found close tag still ends the span early if the body
			// contains `</script` with no later real close. The ceiling is accepted
			// rather than writing an HTML tokenizer; the failure is a refusal, not
			// corruption, because the last-match rule widens the span.
			const closeRe = new RegExp(`</${name}\\s*>`, "gi");
			let end = markdown.length;
			// Bounded: only values of `j` at or after the opening tag can match.
			for (const match of markdown.slice(j).matchAll(closeRe)) {
				end = j + (match.index ?? 0) + match[0].length;
			}
			spans.push({ start: i, end, name, closing: false });
			i = end;
			continue;
		}

		spans.push({ start: i, end: j, name, closing });
		i = j;
	}
	return spans;
}

/**
 * Elements whose content is raw text rather than markup.
 *
 * A `<script>` or `<style>` body can legally contain `>` and `</`, so tag scanning must
 * treat the whole element as one span or it will happily place a mark inside code.
 *
 * ponytail: the close tag is found by regex on the name, so a `</script>` inside a
 * JavaScript string literal inside the script would end the span early. Reaching that
 * needs a script element in a markdown file with a literal `</script>` in a string;
 * the ceiling is accepted rather than writing an HTML tokenizer.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/** Sentinel returned when a range falls inside a mark's text rather than on a tag. */
const MARK_TEXT_MARKER: TagSpan = { start: -1, end: -1, name: "ins", closing: false };

/** Whether `pos` falls strictly inside a tag span. */
function insideAnyTag(spans: readonly TagSpan[], pos: number): boolean {
	return spans.some((span) => pos > span.start && pos < span.end);
}

/**
 * Whether `[start, end)` is clear of every tag.
 *
 * Containment, not "are the endpoints inside a tag". A range whose ends land exactly on
 * tag boundaries is the case the endpoint check missed: measured, `2..23` over
 * `A <del data-id="1">word</del> Z` starts at `<del` and ends at `</del>`, produced
 * `A <ins data-id="2"><del data-id="1">word</ins></del> Z`, and crossed the two tags.
 * A range is only safe if NO tag overlaps it at all.
 *
 * A range inside a mark's own text cannot be exempted either: giving `word` a second
 * mark nests `<ins>` inside `<del>`, and the editor's mark specs declare those mutually
 * exclusive, so the nesting does not survive a round-trip. Proposing inside existing
 * marked text is not a supported edit — the caller proposes against unmarked text, or
 * settles the existing mark first.
 */
/**
 * Whether a range sits inside the TEXT a mark already covers.
 *
 * A range here touches no tag, so containment alone does not catch it — but wrapping
 * text that already belongs to a suggestion nests one mark in another:
 * `A <del data-id="1"><ins data-id="2">word</ins></del> Z`. The schema declares the
 * marks mutually exclusive, so the nesting does not survive a reload.
 *
 * A mark's text is what lies between its opening and closing tag, so this pairs the
 * spans up by element name and tests the gaps.
 */
function rangeInsideMarkText(spans: readonly TagSpan[], start: number, end: number): boolean {
	// An EMPTY range is an insertion point, and `start < end` is false for it, so the
	// gap test below never fired: inserting exactly after `<ins data-id="1">` or just
	// before `</ins>` produced `<ins data-id="1"><ins data-id="2">X</ins>word</ins>`,
	// nesting two mutually-exclusive marks. An insertion point on a mark's own boundary
	// is inside that mark's text as far as the schema is concerned.
	if (start === end) {
		const open: Record<string, number[]> = {};
		for (const span of spans) {
			if (span.name !== "ins" && span.name !== "del") continue;
			const stack = (open[span.name] ??= []);
			if (!span.closing) {
				stack.push(span.end);
				continue;
			}
			const textStart = stack.pop();
			if (textStart === undefined) continue;
			if (start >= textStart && start <= span.start) return true;
		}
		return false;
	}
	const open: Record<string, number[]> = {};
	for (const span of spans) {
		if (span.name !== "ins" && span.name !== "del") continue;
		const stack = (open[span.name] ??= []);
		if (!span.closing) {
			stack.push(span.end);
			continue;
		}
		const textStart = stack.pop();
		if (textStart === undefined) continue;
		// Strictly inside the mark's text, so a range butting against the tag itself is
		// refused by the containment rule rather than this one.
		if (start >= textStart && end <= span.start && start < end) return true;
	}
	return false;
}

function rangeTouchesTag(spans: readonly TagSpan[], start: number, end: number): TagSpan | null {
	return (
		spans.find((span) => {
			// An empty range is an insertion point, and it must be refused at BOTH edges
			// of a span, not only strictly inside it. The closed-at-the-end case is not
			// theoretical: an UNTERMINATED span runs to the end of the block, so
			// inserting at the very end of `<?x a=">" no close` spliced into the
			// instruction and the round-trip corrupted it.
			if (start === end) return start >= span.start && start <= span.end;
			return span.start < end && span.end > start;
		}) ?? null
	);
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
	const spans = scanTagSpans(markdown);

	// Any tag overlap is refused, not just a position strictly inside one.
	//
	// Checking only the two endpoints let a range whose ends landed exactly on tag
	// boundaries through: measured, `2..23` over `A <del data-id="1">word</del> Z`
	// touched no interior point yet still wrapped one tag in another, producing
	// `A <ins data-id="2"><del data-id="1">word</ins></del> Z` with crossed tags.
	//
	// This also covers nesting, which a separate rule used to handle. Marks are
	// mutually exclusive in the schema, so any range that includes a mark's tags - or
	// sits inside its text - builds markup that cannot round-trip. One containment
	// test replaces both, and it is the honest statement of the rule: a proposal
	// covers plain, unmarked text only.
	const collision = rangeTouchesTag(spans, start, end) ?? (rangeInsideMarkText(spans, start, end) ? MARK_TEXT_MARKER : null);
	if (collision) {
		const what =
			collision === MARK_TEXT_MARKER
				? "text an existing suggestion already covers"
				: collision.name === null
					? "an HTML comment or declaration"
					: `a <${collision.name}> tag`;
		const isMark = collision.name === "ins" || collision.name === "del";
		return {
			ok: false,
			code: isMark ? "RANGE_OVERLAPS_MARK" : "RANGE_IN_MARK",
			message:
				`range ${start}..${end} overlaps ${what} at ${collision.start}..${collision.end}. ` +
				`A range is an offset into the block's markdown and must cover plain text ` +
				`only, because a mark cannot wrap or sit inside an existing tag and the ` +
				`resulting markup would not survive a reload. Re-read the block and ` +
				`recompute the offset.`,
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
