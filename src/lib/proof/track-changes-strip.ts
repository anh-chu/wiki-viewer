/**
 * Stripping tracked-change marks before the document is serialized to Markdown.
 *
 * WHY THIS EXISTS (Phase 3.3 — the gate on "buy suggestion mode")
 * ---------------------------------------------------------------
 * `@handlewithcare/prosemirror-suggest-changes` (and any marks-based tracked
 * changes) puts the redline **inside the document** as `insertion` / `deletion` /
 * `modification` marks. Those marks have `toDOM` → `<ins>` / `<del>`, and
 * Turndown converts `<del>` into GFM strikethrough (`~quick~`). So without a
 * filter, a pending deletion gets PERSISTED INTO the canonical `.md`.
 *
 * The markdown file is the product's source of truth and must stay
 * byte-identical while suggestions are pending. That is definition-of-done #3,
 * and nothing in the library provides a serialization hook — the strip has to
 * be ours.
 *
 * WHY IT OPERATES ON THE DOC, NOT THE HTML
 * ----------------------------------------
 * The prior spike stripped the *serialized HTML* with a regex/parse step. Doing
 * it on the ProseMirror node tree instead is strictly stronger:
 *
 *   - no HTML parsing, so no way for an attribute or nesting quirk to smuggle
 *     markup past the filter;
 *   - it is schema-aware, so it cannot corrupt a text node's structure;
 *   - it runs on the exact tree `getHTML()` would serialize, so the property is
 *     about the document, not about one serialization format.
 *
 * Semantics chosen (Google-Docs-compatible redline):
 *   - text marked `insertion`   → DROPPED  (a proposed addition is not content)
 *   - text marked `deletion`    → KEPT     (a proposed removal has not happened)
 *   - text marked `modification`→ KEPT as its base text
 *   - all three marks           → removed from every surviving text node
 *
 * `getBaseText` semantics, but implemented over the doc so it is testable
 * without a DOM and cannot leak through any serialization path.
 */

/** Mark names that carry tracked-change state. */
export const TRACK_CHANGE_MARKS = ["insertion", "deletion", "modification"] as const;

/** Minimal structural view of a ProseMirror node — keeps this module testable. */
export interface PMMarkLike {
	type: { name: string };
}

export interface PMNodeLike {
	type: { name: string };
	marks: readonly PMMarkLike[];
	isText?: boolean;
	text?: string;
	content?: { forEach(fn: (node: PMNodeLike, offset: number) => void): void; size: number };
	childCount?: number;
	child?(index: number): PMNodeLike;
}

function markNames(node: PMNodeLike): string[] {
	return node.marks.map((m) => m.type.name);
}

function isInsertion(node: PMNodeLike): boolean {
	return markNames(node).includes("insertion");
}

/** Drop tracked-change marks from a mark list, preserving all other marks. */
function stripTrackMarks(marks: readonly PMMarkLike[]): PMMarkLike[] {
	const tracked = new Set<string>(TRACK_CHANGE_MARKS);
	return marks.filter((m) => !tracked.has(m.type.name));
}

export interface StripResult {
	/** The same text content a clean document would have. */
	text: string;
	/** How many text nodes were dropped because they were insertions. */
	droppedInsertions: number;
	/** How many text nodes lost a tracked-change mark. */
	strippedMarks: number;
}

/**
 * Walk a ProseMirror document (or fragment) and return the text that should be
 * serialized: insertions dropped, deletions kept, all tracked marks removed.
 *
 * Pure and DOM-free, so it is exercised directly by the byte-identity gate.
 */
export function stripTrackChanges(node: PMNodeLike): StripResult {
	let text = "";
	let droppedInsertions = 0;
	let strippedMarks = 0;

	const visit = (n: PMNodeLike): void => {
		if (n.isText) {
			// A proposed INSERTION is not content — drop it entirely.
			if (isInsertion(n)) {
				droppedInsertions += 1;
				return;
			}
			if (n.marks.length > stripTrackMarks(n.marks).length) strippedMarks += 1;
			text += n.text ?? "";
			return;
		}
		const count = n.childCount ?? 0;
		for (let i = 0; i < count; i += 1) {
			const child = n.child?.(i);
			if (child) visit(child);
		}
	};

	visit(node);
	return { text, droppedInsertions, strippedMarks };
}

/**
 * Serialize a ProseMirror doc to Markdown-ready text with tracked changes
 * stripped, using the app's real Turndown pipeline for the markup layer.
 *
 * The doc is first reduced to its "base" form (insertions dropped, marks
 * removed), then handed to the normal serializer. Because the marks are gone
 * before serialization, no `toDOM` ever emits `<ins>`/`<del>`, so Turndown
 * cannot produce `~...~`.
 */
export function stripTrackChangesFromHTML(html: string): string {
	if (!html) return html;
	// Defensive second layer for HTML that reaches us already serialized (e.g.
	// pasted content, an agent-supplied fragment): remove <ins> wrappers by
	// dropping their contents, and unwrap <del> so deleted text survives.
	let out = html;
	// Drop insertion wrappers AND their contents.
	out = out.replace(/<ins\b[^>]*>[\s\S]*?<\/ins>/gi, "");
	// Unwrap deletion wrappers, keeping the text.
	out = out.replace(/<\/?del\b[^>]*>/gi, "");
	// Unwrap modification wrappers, keeping the text.
	out = out.replace(/<\/?span\b[^>]*data-type="modification"[^>]*>/gi, "");
	return out;
}