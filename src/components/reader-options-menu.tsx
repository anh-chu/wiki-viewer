"use client";

import { Check, Minus, Plus, Type } from "lucide-react";
import { useTheme } from "next-themes";
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
import {
	FONT_PRESETS,
	FONT_PRESET_IDS,
	FONT_SCALE_STEPS,
	type FontPresetId,
	matchFontPreset,
} from "@/lib/fonts";

const THEME_LABEL: Record<string, string> = {
	system: "System",
	light: "Light",
	dark: "Dark",
};
const THEME_ORDER = ["system", "light", "dark"];

interface ReaderOptionsMenuProps {
	className?: string;
}

/**
 * Reading options for a public share page: width, alignment, text size, font, and
 * theme. The full set is always offered, so a reader can find and set a
 * preference before opening the document it applies to.
 *
 * Everything but the theme comes from the same stores the authenticated toolbar
 * and settings sheet use, so a reader's choice applies to the app for that browser
 * too. Text size and font also write the origin-wide `wiki-fonts` value.
 */
export function ReaderOptionsMenu({ className }: ReaderOptionsMenuProps) {
	const width = useViewWidthStore((s) => s.width);
	const setWidth = useViewWidthStore((s) => s.setWidth);
	const align = useViewWidthStore((s) => s.align);
	const setAlign = useViewWidthStore((s) => s.setAlign);
	const bodyScale = useFontStore((s) => s.bodyScale);
	const setScale = useFontStore((s) => s.setScale);
	const applyPreset = useFontStore((s) => s.applyPreset);
	const uiFont = useFontStore((s) => s.ui);
	const bodyFont = useFontStore((s) => s.body);
	const headingFont = useFontStore((s) => s.heading);
	const codeFont = useFontStore((s) => s.code);
	const { theme, setTheme } = useTheme();

	const bodyIndex = Math.max(0, FONT_SCALE_STEPS.indexOf(bodyScale));
	const activePreset: FontPresetId | null = matchFontPreset({
		ui: uiFont,
		body: bodyFont,
		heading: headingFont,
		code: codeFont,
	});
	const activeTheme = theme ?? "system";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					className={`h-7 w-7 p-0 ${className ?? ""}`}
					title="Reading options"
				>
					<Type className="h-3.5 w-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuLabel className="text-[11px] text-muted-foreground">
					Font
				</DropdownMenuLabel>
				{FONT_PRESET_IDS.map((id) => (
					<DropdownMenuItem
						key={id}
						onClick={() => applyPreset(id)}
						className="flex flex-col items-start gap-0.5 text-xs"
					>
						<span className="flex w-full items-center justify-between">
							{FONT_PRESETS[id].label}
							{id === activePreset && <Check className="h-3.5 w-3.5" />}
						</span>
						<span className="w-full truncate text-[10px] text-muted-foreground">
							{FONT_PRESETS[id].description}
						</span>
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
				<DropdownMenuSeparator />
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
					Theme
				</DropdownMenuLabel>
				{THEME_ORDER.map((t) => (
					<DropdownMenuItem
						key={t}
						onClick={() => setTheme(t)}
						className="flex items-center justify-between text-xs"
					>
						{THEME_LABEL[t]}
						{activeTheme === t && <Check className="h-3.5 w-3.5" />}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
