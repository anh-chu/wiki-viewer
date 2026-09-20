/**
 * Mapping between rendered ProseMirror block elements and snapshot blocks.
 *
 * Keyed on IDENTITY, not position. Pairing DOM children to `snapshotBlocks` by array
 * index is wrong whenever the mdast → Tiptap mapping is not 1:1 — a loose list becomes
 * `<ul>` plus nested `<li>`s, a table becomes rows — and once misaligned every
 * subsequent ref is wrong. Every block element carries the ref stamped onto it
 * (`data-block-ref`), so the ref is read off the element rather than inferred.
 */

export interface BlockPosition {
	top: number;
	left: number;
	width: number;
	bottom: number;
	/**
	 * `top` WITHOUT the scroll offset — the position in the scroll container's own
	 * viewport frame.
	 *
	 * `top` includes `scrollTop` because that is what an overlay INSIDE the scrolling
	 * element needs to stay stuck to its block as the text moves. The annotations panel
	 * is a SIBLING of that element, so it does not move with the text and needs this
	 * frame instead; feeding it `top` made every card drift down by the scrolled amount.
	 *
	 * Both come from one `measure()` call, so they cannot describe different layouts.
	 * Optional so existing callers that only need `top` are unaffected.
	 */
	viewportTop?: number;
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
