"use client";

import { Check, AlignJustify } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	useViewWidthStore,
	VIEW_WIDTH_LABEL,
	VIEW_WIDTH_ORDER,
	VIEW_ALIGN_LABEL,
	VIEW_ALIGN_ORDER,
} from "@/stores/view-width-store";

export function ViewWidthToggle({ className }: { className?: string }) {
	const width = useViewWidthStore((s) => s.width);
	const setWidth = useViewWidthStore((s) => s.setWidth);
	const align = useViewWidthStore((s) => s.align);
	const setAlign = useViewWidthStore((s) => s.setAlign);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					className={`h-7 w-7 p-0 ${className ?? ""}`}
					title={`Content width: ${VIEW_WIDTH_LABEL[width]}`}
				>
					<AlignJustify className="h-3.5 w-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-36">
				<DropdownMenuLabel className="text-[11px] text-muted-foreground">
					Width
				</DropdownMenuLabel>
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
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-[11px] text-muted-foreground">
					Alignment
				</DropdownMenuLabel>
				{VIEW_ALIGN_ORDER.map((a) => (
					<DropdownMenuItem
						key={a}
						onClick={() => setAlign(a)}
						className="flex items-center justify-between text-xs"
					>
						{VIEW_ALIGN_LABEL[a]}
						{a === align && <Check className="h-3.5 w-3.5" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
