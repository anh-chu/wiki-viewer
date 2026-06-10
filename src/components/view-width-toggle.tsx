"use client";

import { Check, AlignJustify } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	useViewWidthStore,
	VIEW_WIDTH_LABEL,
	VIEW_WIDTH_ORDER,
} from "@/stores/view-width-store";

export function ViewWidthToggle({ className }: { className?: string }) {
	const width = useViewWidthStore((s) => s.width);
	const setWidth = useViewWidthStore((s) => s.setWidth);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					className={`h-7 w-7 p-0 data-[state=open]:bg-accent ${className ?? ""}`}
					title={`Content width: ${VIEW_WIDTH_LABEL[width]}`}
				>
					<AlignJustify className="h-3.5 w-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-36">
				{VIEW_WIDTH_ORDER.map((w) => (
					<DropdownMenuItem
						key={w}
						onClick={() => setWidth(w)}
						className="flex items-center justify-between text-xs"
					>
						{VIEW_WIDTH_LABEL[w]}
						{w === width && <Check className="h-3.5 w-3.5" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
