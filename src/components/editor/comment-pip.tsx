"use client";

import { CheckCircle2, MessageCircle } from "lucide-react";
import type { Comment } from "@/lib/proof/types";

interface Props {
	blockRef: string;
	comments: Comment[];
	top: number;
	left: number;
	onClick: () => void;
}

/**
 * Gutter pip rendered absolutely inside the editor scroll container.
 * Positioned via `top`/`left` props (pixels relative to scroll container).
 */
export function CommentPip({ blockRef, comments, top, left, onClick }: Props) {
	if (comments.length === 0) return null;

	const open = comments.filter((c) => !c.resolved);
	const allResolved = open.length === 0;

	let variant: "dot-ai" | "ring-human" | "check";
	if (allResolved) {
		variant = "check";
	} else {
		const lastTurn = open[0].turns.at(-1);
		variant = lastTurn?.by.startsWith("ai:") ? "dot-ai" : "ring-human";
	}

	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				position: "absolute",
				top,
				left,
				transform: "translateY(2px)",
			}}
			className="z-10 p-2 sm:p-0.5 -m-1.5 sm:m-0 rounded transition-colors hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			aria-label={`Comment thread for block ${blockRef}`}
		>
			{variant === "check" && (
				<CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground/30" />
			)}
			{variant === "dot-ai" && (
				<MessageCircle className="h-3.5 w-3.5 fill-primary text-primary" />
			)}
			{variant === "ring-human" && (
				<MessageCircle className="h-3.5 w-3.5 text-muted-foreground/70" />
			)}
		</button>
	);
}
