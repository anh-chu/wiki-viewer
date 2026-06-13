"use client";

import { MessageCircle } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

interface Props {
	/** The scrollable container that wraps the editor content. */
	containerRef: RefObject<HTMLElement | null>;
	onComment: () => void;
}

/**
 * Floating comment button for read-only view mode.
 *
 * TipTap's BubbleMenu doesn't fire when the editor is non-editable, so this
 * component listens to the native selectionchange event and positions a small
 * button above whatever the user has selected — as long as the selection is
 * inside the editor container.
 */
export function ViewModeCommentButton({ containerRef, onComment }: Props) {
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

	useEffect(() => {
		function update() {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
				setPos(null);
				return;
			}
			const range = sel.getRangeAt(0);
			const container = containerRef.current;
			if (!container || !container.contains(range.commonAncestorContainer)) {
				setPos(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			// rect can be all-zeros for collapsed or invisible ranges
			if (rect.width === 0 && rect.height === 0) {
				setPos(null);
				return;
			}
			setPos({
				top: rect.top - 38,
				left: rect.left + rect.width / 2,
			});
		}

		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	}, [containerRef]);

	if (!pos) return null;

	return (
		<button
			type="button"
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				transform: "translateX(-50%)",
				zIndex: 50,
			}}
			className="flex items-center gap-1 px-2 py-1 bg-popover border border-border rounded-sm shadow-lg text-[12px] text-foreground/80 hover:text-foreground hover:bg-accent transition-colors"
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => {
				onComment();
				setPos(null);
			}}
			aria-label="Add comment"
			title="Add comment"
		>
			<MessageCircle className="w-3.5 h-3.5" />
			<span>Comment</span>
		</button>
	);
}
