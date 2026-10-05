"use client";

import { Check, AlignJustify, Minus, Plus } from "lucide-react";
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
import { useFontStore } from "@/stores/font-store";
import { FONT_SCALE_STEPS } from "@/lib/fonts";

export function ViewWidthToggle({ className }: { className?: string }) {
	const width = useViewWidthStore((s) => s.width);
	const setWidth = useViewWidthStore((s) => s.setWidth);
	const align = useViewWidthStore((s) => s.align);
	const setAlign = useViewWidthStore((s) => s.setAlign);
	// Body text size is the reader setting the share page applies to prose.
	const bodyScale = useFontStore((s) => s.bodyScale);
	const setScale = useFontStore((s) => s.setScale);
	const bodyIndex = Math.max(0, FONT_SCALE_STEPS.indexOf(bodyScale));

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
				<DropdownMenuSeparator />
				<DropdownMenuLabel className="text-[11px] text-muted-foreground">
					Text size — {Math.round(bodyScale * 100)}%
				</DropdownMenuLabel>
				{/* Steppers keep the menu open, so a reader can step more than once. */}
				<DropdownMenuItem
					disabled={bodyIndex <= 0}
					onSelect={(event) => {
						event.preventDefault();
						setScale("body", FONT_SCALE_STEPS[bodyIndex - 1]);
					}}
					className="flex items-center justify-between text-xs"
				>
					Smaller
					<Minus className="h-3.5 w-3.5" />
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={bodyIndex >= FONT_SCALE_STEPS.length - 1}
					onSelect={(event) => {
						event.preventDefault();
						setScale("body", FONT_SCALE_STEPS[bodyIndex + 1]);
					}}
					className="flex items-center justify-between text-xs"
				>
					Larger
					<Plus className="h-3.5 w-3.5" />
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
