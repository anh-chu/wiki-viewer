"use client";

import type * as React from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";

interface TipProps {
	content: string;
	side?: "top" | "bottom" | "left" | "right";
	children: React.ReactNode;
}

export function Tip({ content, side = "top", children }: TipProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side={side}>{content}</TooltipContent>
		</Tooltip>
	);
}
