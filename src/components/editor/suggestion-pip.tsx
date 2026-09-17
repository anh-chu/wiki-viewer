"use client";

import { SquarePen } from "lucide-react";
import type { MouseEventHandler } from "react";
import { useState } from "react";

interface Props { top: number; left: number; count: number; onClick: MouseEventHandler<HTMLButtonElement>; "aria-label": string; anchorKey?: string }

/** Gutter pip with a co-located, queryable span used for review anchoring. */
export function SuggestionPip({ top, left, count, onClick, "aria-label": ariaLabel, anchorKey }: Props) {
	const [hovered, setHovered] = useState(false);
	return <>
		<span aria-hidden="true" data-annotation-span={ariaLabel} className={`pointer-events-none absolute z-[1] rounded text-transparent transition-colors ${hovered ? "bg-primary/5" : ""}`} style={{ top, left: Math.max(0, left + 20), width: "min(32rem, calc(100vw - 4rem))", minHeight: 20 }} />
		<button type="button" onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: "absolute", top, left, transform: "translateY(2px)", pointerEvents: "auto" }} className="z-10 -m-1.5 rounded p-2 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-success focus:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:m-0 sm:p-0.5" aria-label={ariaLabel}>
			<SquarePen className="h-3.5 w-3.5" />{count > 1 && <sup className="ml-0.5 text-[9px] leading-none">{count}</sup>}
		</button>
	</>;
}
