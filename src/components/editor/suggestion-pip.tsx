"use client";

import { SquarePen } from "lucide-react";
import type { MouseEventHandler } from "react";

interface Props {
	top: number;
	left: number;
	count: number;
	onClick: MouseEventHandler<HTMLButtonElement>;
	"aria-label": string;
}

/**
 * Gutter pip rendered absolutely inside the editor scroll container.
 * Positioned via `top`/`left` props (pixels relative to scroll container).
 */
export function SuggestionPip({ top, left, count, onClick, "aria-label": ariaLabel }: Props) {
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				position: "absolute",
				top,
				left,
				transform: "translateY(2px)",
				pointerEvents: "auto",
			}}
			className="z-10 p-2 sm:p-0.5 -m-1.5 sm:m-0 rounded transition-colors text-muted-foreground/70 hover:text-success hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			aria-label={ariaLabel}
		>
			<SquarePen className="h-3.5 w-3.5" />
			{count > 1 && (
				<sup className="ml-0.5 text-[9px] leading-none">{count}</sup>
			)}
		</button>
	);
}
