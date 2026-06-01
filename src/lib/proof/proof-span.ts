import type { SpanAttrs } from "./types";

export type { SpanAttrs };

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function buildAttrs(attrs: SpanAttrs): string {
	const parts: string[] = [
		`id="${escapeAttr(attrs.spanId)}"`,
		`origin="${attrs.origin}"`,
	];
	if (attrs.basis) parts.push(`basis="${escapeAttr(attrs.basis)}"`);
	if (attrs.basisDetail) parts.push(`basis-detail="${escapeAttr(attrs.basisDetail)}"`);
	parts.push(`by="${escapeAttr(attrs.by)}"`);
	parts.push(`at="${escapeAttr(attrs.at)}"`);
	if (attrs.inResponseTo) parts.push(`in-response-to="${escapeAttr(attrs.inResponseTo)}"`);
	return parts.join(" ");
}

/**
 * Wrap the text content of a markdown block in a <proof-span>.
 *
 * Wrap rules:
 *   paragraph    -> wrap full markdown text
 *   heading      -> wrap text after the leading "#"s
 *   bulletList / orderedList / taskList -> wrap each list item's text line
 *   blockquote   -> wrap text content (after "> " prefix)
 *   codeBlock / table / hr / html -> return null (caller records in sidecar.blockProvenance)
 */
export function wrapAsProofSpan(
	markdown: string,
	attrs: SpanAttrs,
): string | null {
	const a = buildAttrs(attrs);

	// Detect block type from markdown shape
	const trimmed = markdown.trim();

	// code block
	if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) return null;

	// html block
	if (trimmed.startsWith("<") && !trimmed.startsWith("<proof-span")) return null;

	// hr
	if (/^[-*_]{3,}\s*$/.test(trimmed)) return null;

	// table (contains | pipes in first line)
	const firstLine = trimmed.split("\n")[0];
	if (firstLine.includes("|") && /^\|.*\|/.test(firstLine)) return null;

	// heading: "# text" -> "# <proof-span ...>text</proof-span>"
	const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
	if (headingMatch) {
		const hashes = headingMatch[1];
		const text = headingMatch[2].trimEnd();
		return `${hashes} <proof-span ${a}>${text}</proof-span>`;
	}

	// blockquote: each line starts with "> "
	if (trimmed.startsWith(">")) {
		return trimmed
			.split("\n")
			.map((line) => {
				const bqMatch = line.match(/^(>\s?)(.*)/);
				if (!bqMatch) return line;
				const prefix = bqMatch[1];
				const content = bqMatch[2];
				if (!content.trim()) return line;
				return `${prefix}<proof-span ${a}>${content}</proof-span>`;
			})
			.join("\n");
	}

	// list items (bullet/ordered/task)
	// Each item starts with "- ", "* ", "+ ", or "N. "
	// Task items: "- [ ] " or "- [x] "
	const listItemRe = /^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)(.*)/;
	if (listItemRe.test(trimmed.split("\n")[0])) {
		return trimmed
			.split("\n")
			.map((line) => {
				const m = line.match(/^(\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?)(.*)/);
				if (!m) return line;
				const prefix = m[1];
				const content = m[2];
				if (!content.trim()) return line;
				return `${prefix}<proof-span ${a}>${content}</proof-span>`;
			})
			.join("\n");
	}

	// paragraph: wrap the whole thing
	return `<proof-span ${a}>${trimmed}</proof-span>`;
}

/**
 * Remove all <proof-span ...>...</proof-span> wrappers, keeping inner content.
 * Used for "Accept" (keep text, drop attribution).
 */
export function unwrapProofSpans(markdown: string): string {
	return markdown.replace(/<proof-span\b[^>]*>([\s\S]*?)<\/proof-span>/g, "$1");
}

/**
 * Remove a specific <proof-span id="spanId">...</proof-span>, discarding content.
 * Used for "Revert" (delete AI-authored text).
 */
export function revertProofSpan(markdown: string, spanId: string): string {
	const escapedId = spanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`<proof-span\\b[^>]*\\bid="${escapedId}"[^>]*>[\\s\\S]*?<\\/proof-span>`,
		"g",
	);
	return markdown.replace(re, "");
}

/**
 * Extract all span IDs from a markdown string.
 */
export function extractSpanIds(markdown: string): string[] {
	const ids: string[] = [];
	const re = /<proof-span\b[^>]*\bid="([^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(markdown)) !== null) {
		ids.push(m[1]);
	}
	return ids;
}

/**
 * Generate a unique span ID "p" + 4-hex.
 */
export function newSpanId(): string {
	const hex = Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
	return `p${hex}`;
}
