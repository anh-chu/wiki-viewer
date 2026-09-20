/**
 * Mapping between rendered ProseMirror block elements and snapshot blocks.
 *
 * HISTORY / WHY THIS MODULE EXISTS
 * ---------------------------------
 * The original mapping lived inline in `editor.tsx` and paired DOM children to
 * `snapshotBlocks` **by array index**:
 *
 *     for (let i = 0; i < Math.min(children.length, snapshotBlocks.length - offset); i++)
 *
 * That is wrong whenever the mdast → Tiptap node mapping is not 1:1. One mdast
 * node can expand into several DOM nodes (loose lists become `<ul>` + nested
 * `<li>`s; tables become `<table>` + rows; blockquote wraps a paragraph) or
 * several can collapse into one. Once misaligned, every subsequent ref is
 * wrong, and `Math.min` truncated the loop silently instead of failing.
 *
 * The fix keys on **identity**: every block element carries the ref that was
 * stamped onto it (`data-block-ref`), so we read the ref off the element rather
 * than inferring it from position. `alignByStampedRef` is the only mapping path;
 * the old index-based loop is gone rather than kept around for a test to call.
 */

interface BlockPosition {
	top: number;
	left: number;
	width: number;
	bottom: number;
}

/** Minimal structural view of a DOM element — keeps this unit testable headlessly. */
export interface BlockElementLike {
	/** The `data-block-ref` attribute value, or null when unstamped. */
	getAttribute(name: string): string | null;
	/** A rect-like position source; the caller supplies the real measurement. */
	measure(): BlockPosition;
}

interface AlignResult {
	positions: Map<string, BlockPosition>;
	/** Refs that had no matching element — surfaced, never silently dropped. */
	unmatchedRefs: string[];
	/** Elements carrying no ref, or a ref absent from the snapshot. */
	orphanElements: number;
}

/**
 * The fix (Phase 4): map by the ref stamped on the element.
 *
 * Elements that cannot be mapped are counted rather than ignored, and refs with
 * no element are returned so callers can surface them (the original loop let
 * both cases vanish).
 */
export function alignByStampedRef(
	elements: readonly BlockElementLike[],
	snapshotBlocks: readonly { ref: string }[],
	snapshotBlockOffset = 0,
): AlignResult {
	const expected = new Set(
		snapshotBlocks.slice(snapshotBlockOffset).map((b) => b.ref),
	);
	const positions = new Map<string, BlockPosition>();
	let orphanElements = 0;

	for (const el of elements) {
		const ref = el.getAttribute("data-block-ref");
		if (!ref) {
			orphanElements += 1;
			continue;
		}
		if (!expected.has(ref)) {
			orphanElements += 1;
			continue;
		}
		positions.set(ref, el.measure());
	}

	const unmatchedRefs = [...expected].filter((ref) => !positions.has(ref));
	return { positions, unmatchedRefs, orphanElements };
}
