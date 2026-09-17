"use client";

import { CheckCircle2, MessageCircle } from "lucide-react";
import { useState } from "react";
import type { Comment } from "@/lib/proof/types";

interface Props { anchorKey: string; anchorLabel?: string; comments: Comment[]; top: number; left: number; onClick: () => void }

/** Gutter pip with a co-located, queryable span used for thread anchoring. */
export function CommentPip({ anchorKey, anchorLabel, comments, top, left, onClick }: Props) {
	const [hovered, setHovered] = useState(false);
	if (comments.length === 0) return null;
	const open = comments.filter((c) => !c.resolved);
	const allResolved = open.length === 0;
	let variant: "dot-ai" | "ring-human" | "check";
	if (allResolved) variant = "check";
	else variant = open[0].turns.at(-1)?.by.startsWith("ai:") ? "dot-ai" : "ring-human";
	return <>
		<span aria-hidden="true" data-annotation-span={anchorKey} className={`pointer-events-none absolute z-[1] rounded text-transparent transition-colors ${hovered ? "bg-primary/5" : ""}`} style={{ top, left: Math.max(0, left + 20), width: "min(32rem, calc(100vw - 4rem))", minHeight: 20 }}>{anchorLabel ?? anchorKey}</span>
		<button type="button" onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: "absolute", top, left, transform: "translateY(2px)" }} className="z-10 -m-1.5 rounded p-2 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:m-0 sm:p-0.5" aria-label={`Comment thread for ${anchorLabel ?? anchorKey}`}>
			{variant === "check" && <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground/30" />}
			{variant === "dot-ai" && <MessageCircle className="h-3.5 w-3.5 fill-primary text-primary" />}
			{variant === "ring-human" && <MessageCircle className="h-3.5 w-3.5 text-muted-foreground/70" />}
		</button>
	</>;
}
