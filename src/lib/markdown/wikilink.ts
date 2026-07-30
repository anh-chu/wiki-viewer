/**
 * Canonical wiki-link extractor and slug helpers.
 *
 * This module is the single source of truth for the indexer and the API routes.
 * The lenient-capture-plus-strict-validation design means adopting this module
 * in the renderer later is a no-op refactor.
 */

/**
 * Lenient capture regex. Matches [[capture]], [[capture|alias]],
 * [[capture#anchor]] where capture is [^\]|#\n]+.
 * Groups: 1=slug  2=alias  3=anchor
 */
export const WIKILINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]*)|#([^\]]*))?\]\]/g;

/** Valid slug: lowercase letters, digits, hyphens. */
export const SLUG_VALID_RE = /^[a-z0-9-]+$/;

/** Trim and lowercase a raw slug candidate. */
export function normalizeSlug(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Derive the canonical slug from a relative file path.
 * Takes the last segment, strips .md / .markdown, lowercases.
 */
export function slugFromPath(relPath: string): string {
	const base = relPath.split("/").pop() ?? relPath;
	return base.replace(/\.(?:md|markdown)$/i, "").toLowerCase();
}

export interface WikiLinkOccurrence {
	/** Normalised lowercase slug. */
	slug: string;
	/** 1-based line number. */
	line: number;
	/** Full text of the line containing the link. */
	lineText: string;
	/** 0-based index of the `[[` within lineText (from regex.lastIndex). */
	index: number;
}

/**
 * Extract all wiki-link occurrences from markdown text.
 *
 * One entry per occurrence. Slug is normalised (lowercase, trimmed) and filtered
 * by SLUG_VALID_RE so `[[my page]]` and `[[Foo]]` are excluded (the former has a
 * space, the latter is uppercase). Line numbers are computed in one pass — the
 * text is never re-split per match.
 *
 * Handles CRLF, LF, and CR line endings.
 */
export function extractWikiLinks(text: string): WikiLinkOccurrence[] {
	const results: WikiLinkOccurrence[] = [];

	// Compute line-start offsets in one pass.
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			lineStarts.push(i + 1);
		} else if (text[i] === "\r") {
			if (i + 1 < text.length && text[i + 1] === "\n") {
				i++; // skip \n of CRLF
			}
			lineStarts.push(i + 1);
		}
	}

	// Reset the shared regex before use.
	WIKILINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = WIKILINK_RE.exec(text)) !== null) {
		const raw = match[1];
		if (!raw) continue;
		const slug = normalizeSlug(raw);
		if (!SLUG_VALID_RE.test(slug)) continue;

		// Find the line number via binary search on lineStarts.
		const idx = match.index;
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (lineStarts[mid]! <= idx) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		const line = lo + 1; // 1-based

		// Get the full line text.
		const lineStart = lineStarts[lo]!;
		const lineEnd = lo + 1 < lineStarts.length
			? lineStarts[lo + 1]!
			: text.length;
		const lineText = text.slice(lineStart, lineEnd).replace(/\r?\n$/, "");

		results.push({ slug, line, lineText, index: idx - lineStart });
	}
	return results;
}
