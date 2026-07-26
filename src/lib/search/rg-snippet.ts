/**
 * Pure functions that turn a ripgrep --json submatch event into the <mark>
 * snippet string that src/components/search/snippet-text.tsx already parses.
 *
 * No I/O — unit-testable without spawning anything.
 *
 * CRITICAL: ripgrep submatch start/end are BYTE offsets into the line. We
 * convert via Buffer.from(lineText, "utf8"), slice by byte, and decode each
 * segment — never index the JS string directly, or every non-ASCII line
 * highlights the wrong span.
 */

export const SNIPPET_WINDOW = 60;

export interface RgSubmatch {
	start: number;
	end: number;
}

export interface SnippetOpts {
	/** Characters of context either side of the first submatch (default 60). */
	window?: number;
}

/**
 * Strip literal <mark> and </mark> substrings so a source file containing
 * those strings cannot forge a highlight in the snippet output.
 */
export function stripMarkTags(text: string): string {
	return text.replace(/<\/?mark>/g, "");
}

/**
 * Build a snippet string from a line of text and ripgrep's byte-offset
 * submatches. The output uses `<mark>…</mark>` pairs, which is the exact
 * contract `SnippetText` expects.
 *
 * The window is centred on the first submatch; segments beyond the window are
 * elided with `…` markers. Submatches that fall partly or wholly outside the
 * window are excluded from highlighting.
 *
 * Window boundaries are rounded to UTF-8 code-point boundaries so that a
 * mixed-width line is never sliced between code points (U+FFFD). Submatch
 * byte offsets are unchanged — only the window edges are adjusted.
 */
export function buildSnippet(
	lineText: string,
	submatches: RgSubmatch[],
	opts: SnippetOpts = {},
): string {
	const window = opts.window ?? SNIPPET_WINDOW;
	if (!submatches.length) return stripMarkTags(lineText);

	// Work in byte space — ripgrep offsets are byte indices into the UTF-8
	// encoding of the line.
	const buf = Buffer.from(lineText, "utf8");
	const totalBytes = buf.length;

	// Sort submatches by start position
	const sorted = [...submatches].sort((a, b) => a.start - b.start);

	// Compute the byte window around the first submatch, then round to
	// UTF-8 code-point boundaries so the window never slices a character.
	const first = sorted[0]!;
	const firstCentre = Math.floor((first.start + first.end) / 2);
	let winStart = Math.max(0, firstCentre - window);
	let winEnd = Math.min(totalBytes, firstCentre + window);

	// Round winStart forward to the next code-point start (skip continuation bytes).
	while (winStart > 0 && (buf[winStart]! & 0xc0) === 0x80) winStart++;
	// Round winEnd backward to a code-point start (or forward if at a start).
	while (winEnd < totalBytes && (buf[winEnd]! & 0xc0) === 0x80) winEnd--;

	// Keep only submatches that overlap the window (at least partially)
	const visible = sorted.filter(
		(s) => s.start < winEnd && s.end > winStart,
	);

	// Build segments: walk through visible submatches, emitting plain text
	// between them and <mark> around them. Before the first submatch and after
	// the last, emit the remaining window text.
	const segments: { text: string; mark: boolean }[] = [];

	let cursor = winStart;

	for (const sub of visible) {
		// Clamp the submatch to the window
		const s = Math.max(winStart, sub.start);
		const e = Math.min(winEnd, sub.end);

		if (s > cursor) {
			segments.push({
				text: buf.toString("utf8", cursor, s),
				mark: false,
			});
		}
		if (e > s) {
			segments.push({
				text: buf.toString("utf8", s, e),
				mark: true,
			});
		}
		cursor = e;
	}

	// Remaining text after the last submatch within the window
	if (cursor < winEnd) {
		segments.push({
			text: buf.toString("utf8", cursor, winEnd),
			mark: false,
		});
	}

	// Compose the final string
	let result = "";
	if (winStart > 0) result += "…";
	for (const seg of segments) {
		const clean = stripMarkTags(seg.text);
		result += seg.mark ? `<mark>${clean}</mark>` : clean;
	}
	if (winEnd < totalBytes) result += "…";

	return result;
}
