"use client";

import { MessageCircle, Sparkles } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

interface Props {
	/** The scrollable container that wraps the editor content. */
	containerRef: RefObject<HTMLElement | null>;
	onComment: () => void;
	/** Optional: when provided, an "Ask agent" action appears beside Comment. */
	onAskAgent?: () => void;
	/**
	 * "center": floating above the selection, centered (markdown default).
	 * "left": pinned to the container's left edge, beside the selected line
	 * (code/source — keeps it out of the empty right space).
	 */
	align?: "center" | "left";
}

/**
 * Floating comment button for read-only view mode.
 *
 * TipTap's BubbleMenu doesn't fire when the editor is non-editable, so this
 * component listens to the native selectionchange event and positions a small
 * button relative to whatever the user has selected — as long as the selection
 * is inside the editor container.
 */
export function ViewModeCommentButton({
	containerRef,
	onComment,
	onAskAgent,
	align = "center",
}: Props) {
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
			if (align === "left") {
				// Beside the selected line, pinned to the container's left edge.
				const cRect = container.getBoundingClientRect();
				setPos({ top: rect.top, left: cRect.left + 8 });
			} else {
				setPos({ top: rect.top - 38, left: rect.left + rect.width / 2 });
			}
		}

		document.addEventListener("selectionchange", update);
		return () => document.removeEventListener("selectionchange", update);
	}, [containerRef, align]);

	if (!pos) return null;

	return (
		<div
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				transform: align === "left" ? undefined : "translateX(-50%)",
				zIndex: 50,
			}}
			className="flex items-center gap-0.5 bg-popover border border-border rounded-sm shadow-lg"
			onMouseDown={(e) => e.preventDefault()}
		>
			<button
				type="button"
				className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/80 hover:text-foreground hover:bg-accent rounded-sm transition-colors"
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
			{onAskAgent && (
				<button
					type="button"
					className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/80 hover:text-foreground hover:bg-accent rounded-sm border-l border-border transition-colors"
					onClick={() => {
						onAskAgent();
						setPos(null);
					}}
					aria-label="Ask agent"
					title="Ask agent"
				>
					<Sparkles className="w-3.5 h-3.5" />
					<span>Ask agent</span>
				</button>
			)}
		</div>
	);
}
