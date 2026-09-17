"use client";

import { CheckCircle2, MessageCircle, SquarePen } from "lucide-react";
import { useEffect, useState } from "react";

type HighlightRect = { top: number; left: number; width: number; height: number };
import type { Comment } from "@/lib/proof/types";

interface Props { anchorKey: string; anchorLabel?: string; comments: Comment[]; top: number; left: number; onClick: () => void; variant?: "comment" | "instruction" }

/** Gutter pip with a co-located, queryable span used for thread anchoring. */
export function CommentPip({ anchorKey, anchorLabel, comments, top, left, onClick, variant = "comment" }: Props) {
	const [hovered, setHovered] = useState(false);
	const [highlightRect, setHighlightRect] = useState<HighlightRect | null>(null);
	useEffect(() => {
		if (!hovered) return;
		const overlay = document.querySelector("[data-editor-scroll] > div[aria-hidden=\"true\"]");
		const block = document.querySelector(`[data-block-ref=\"${CSS.escape(anchorKey)}\"]`);
		if (!overlay || !block) return;
		const overlayRect = overlay.getBoundingClientRect();
		const blockRect = block.getBoundingClientRect();
		setHighlightRect({ top: blockRect.top - overlayRect.top, left: blockRect.left - overlayRect.left, width: blockRect.width, height: blockRect.height });
	}, [anchorKey, hovered, top, left]);
	const highlightStyle = highlightRect ?? { top, left: Math.max(0, left + 20), width: "min(32rem, calc(100vw - 4rem))", minHeight: 20 };
	if (comments.length === 0) return null;
	if (variant === "instruction") {
		return <>
			<span aria-hidden="true" data-annotation-span={anchorKey} className={`pointer-events-none absolute z-[1] rounded text-transparent transition-colors ${hovered ? "bg-amber-500/5" : ""}`} style={highlightStyle}>{anchorLabel ?? anchorKey}</span>
			<button type="button" onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: "absolute", top, left, transform: "translateY(2px)" }} className="z-10 -m-1.5 rounded p-2 text-amber-600/80 transition-colors hover:bg-amber-500/10 hover:text-amber-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 sm:m-0 sm:p-0.5" aria-label={`Instruction thread for ${anchorLabel ?? anchorKey}`}>
				<SquarePen className="h-3.5 w-3.5" />
			</button>
		</>;
	}
	const open = comments.filter((c) => !c.resolved);
	const allResolved = open.length === 0;
	let commentVariant: "dot-ai" | "ring-human" | "check";
	if (allResolved) commentVariant = "check";
	else commentVariant = open[0].turns.at(-1)?.by.startsWith("ai:") ? "dot-ai" : "ring-human";
	return <>
		<span aria-hidden="true" data-annotation-span={anchorKey} className={`pointer-events-none absolute z-[1] rounded text-transparent transition-colors ${hovered ? "bg-primary/5" : ""}`} style={highlightStyle}>{anchorLabel ?? anchorKey}</span>
		<button type="button" onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: "absolute", top, left, transform: "translateY(2px)" }} className="z-10 -m-1.5 rounded p-2 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:m-0 sm:p-0.5" aria-label={`Comment thread for ${anchorLabel ?? anchorKey}`}>
			{commentVariant === "check" && <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground/30" />}
			{commentVariant === "dot-ai" && <MessageCircle className="h-3.5 w-3.5 fill-primary text-primary" />}
			{commentVariant === "ring-human" && <MessageCircle className="h-3.5 w-3.5 text-muted-foreground/70" />}
		</button>
	</>;
}
