/**
 * Pip / popover geometry (Phase 4).
 *
 * WHY THIS EXISTS
 * ---------------
 * Positioning was hand-rolled with `getBoundingClientRect` arithmetic in
 * `comment-pip.tsx` and `editor.tsx`, and that math was a direct contributor to
 * the pip-inconsistency bug. `@floating-ui/dom` (353M downloads/month, already
 * vendored by Tiptap's own BubbleMenu) replaces it.
 *
 * The split matters: Floating UI computes placement from an anchor + floating
 * rect, but the app already knows the block's measured rect from
 * `blockRefPositions`. So this module owns the *policy* (which anchor, which
 * side, how to clamp into the viewport) and delegates the *math* to Floating UI.
 */
import { computePosition, offset, shift, flip } from "@floating-ui/dom";

export interface PipAnchorInput {
	/** The measured block rect, already relative to the scroll container. */
	top: number;
	left: number;
	width: number;
	bottom: number;
}

export interface PipPlacement {
	top: number;
	left: number;
	/** True when the pip had to be clamped back inside the viewport. */
	clamped: boolean;
}

/** Gutter offset: how far the pip sits to the left of the block's left edge. */
export const PIP_GUTTER_OFFSET = 20;

/**
 * Place a gutter pip next to its block.
 *
 * Pure arithmetic on already-measured rects — no DOM access — so the layout
 * policy is testable headlessly. `computePosition` is used by the component when
 * a real floating element exists (popovers), where live layout matters.
 */
export function placePip(
	anchor: PipAnchorInput,
	viewportWidth: number,
	pipWidth = 28,
): PipPlacement {
	// Preferred: in the left gutter, vertically aligned with the block.
	const preferredLeft = anchor.left - pipWidth - PIP_GUTTER_OFFSET / 2;
	let left = preferredLeft;
	let clamped = false;

	// No gutter on a narrow viewport (preferredLeft < 0), or the block extends
	// past the right edge: clamp inside the viewport instead of rendering
	// off-screen. The previous hand-rolled math produced left < 0 here, which is
	// how pips ended up invisible on mobile.
	const blockOverflowsRight = anchor.left + anchor.width > viewportWidth;
	if (left < 0 || blockOverflowsRight) {
		left = Math.min(anchor.left + anchor.width - pipWidth, viewportWidth - pipWidth);
		left = Math.max(0, left);
		clamped = true;
	}
	if (left + pipWidth > viewportWidth) {
		left = Math.max(0, viewportWidth - pipWidth);
		clamped = true;
	}

	return { top: anchor.top, left, clamped };
}

/**
 * Position a floating element (thread popover, suggestion card) against an
 * anchor element using Floating UI.
 *
 * `strategy: "absolute"` keeps it inside the editor's positioned scroll
 * container, which is what the existing thread UI expects.
 */
export async function positionFloating(
	anchorEl: HTMLElement,
	floatingEl: HTMLElement,
	placement: "right-start" | "bottom-start" = "right-start",
): Promise<{ x: number; y: number }> {
	const { x, y } = await computePosition(anchorEl, floatingEl, {
		placement,
		strategy: "absolute",
		middleware: [offset(8), flip(), shift({ padding: 8 })],
	});
	return { x, y };
}

/** Apply a computed floating position to an element. */
export function applyFloatingPosition(
	el: HTMLElement,
	position: { x: number; y: number },
): void {
	el.style.position = "absolute";
	el.style.left = `${position.x}px`;
	el.style.top = `${position.y}px`;
}