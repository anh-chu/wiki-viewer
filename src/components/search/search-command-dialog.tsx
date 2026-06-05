"use client";

/**
 * Command palette (cmd+k / ctrl+k) for full-text search + app actions.
 * Mounts once in the app shell; visibility is driven by the search store.
 *
 * Action mode activates when the query is empty or starts with ">".
 * New optional props let the parent wire page-level callbacks; they default
 * to no-ops so this component compiles without any parent changes.
 */
import { useEffect } from "react";
import {
	AlignCenter,
	Bot,
	Copy,
	FilePlus,
	Moon,
	PanelLeft,
	Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { useSearchStore } from "@/stores/search-store";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import {
	useViewWidthStore,
	VIEW_WIDTH_LABEL,
	VIEW_WIDTH_ORDER,
} from "@/stores/view-width-store";
import { SnippetText } from "./snippet-text";

export interface SearchCommandDialogProps {
	onOpenFile: (relPath: string) => void;
	/** Wire to page-level sidebar toggle. Defaults to no-op. */
	onToggleSidebar?: () => void;
	/** Wire to page-level new-file action. Defaults to no-op. */
	onNewFile?: () => void;
	/** Wire to page-level copy-path action. Defaults to no-op. */
	onCopyPath?: () => void;
}

export function SearchCommandDialog({
	onOpenFile,
	onToggleSidebar = () => undefined,
	onNewFile = () => undefined,
	onCopyPath = () => undefined,
}: SearchCommandDialogProps) {
	const open = useSearchStore((s) => s.open);
	const setOpen = useSearchStore((s) => s.setOpen);
	const query = useSearchStore((s) => s.query);
	const setQuery = useSearchStore((s) => s.setQuery);
	const results = useSearchStore((s) => s.results);
	const loading = useSearchStore((s) => s.loading);
	const truncated = useSearchStore((s) => s.truncated);
	const search = useSearchStore((s) => s.search);

	const { resolvedTheme, setTheme } = useTheme();
	const toggleAIPanel = useAIPanelStore((s) => s.toggle);
	const viewWidth = useViewWidthStore((s) => s.width);
	const cycleViewWidth = useViewWidthStore((s) => s.cycle);

	// Action mode: empty query or ">" prefix (VS Code convention).
	const trimmed = query.trimStart();
	const isActionMode = trimmed === "" || trimmed.startsWith(">");

	// The bare text to actually search files (strip leading ">").
	const fileQuery = isActionMode ? "" : query;

	// Global cmd+k / ctrl+k toggle.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen(!open);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, setOpen]);

	// Debounced search — only fires when NOT in action mode.
	useEffect(() => {
		if (!open) return;
		if (isActionMode) return;
		const id = setTimeout(() => {
			void search(fileQuery);
		}, 120);
		return () => clearTimeout(id);
	}, [fileQuery, isActionMode, open, search]);

	// Helper: run action then close.
	function runAction(fn: () => void) {
		fn();
		setOpen(false);
		setQuery("");
	}

	// Next view-width label for display.
	const nextWidthIdx =
		(VIEW_WIDTH_ORDER.indexOf(viewWidth) + 1) % VIEW_WIDTH_ORDER.length;
	const nextWidthLabel = VIEW_WIDTH_LABEL[VIEW_WIDTH_ORDER[nextWidthIdx]];

	return (
		<CommandDialog
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) setQuery("");
			}}
			// cmdk's built-in fuzzy filter would re-rank our BM25 results; disable it.
			shouldFilter={false}
		>
			<CommandInput
				placeholder="Search files… ( > for actions )"
				value={query}
				onValueChange={setQuery}
			/>
			<CommandList>
				{/* ── Action mode ─────────────────────────────────────── */}
				{isActionMode && (
					<CommandGroup heading="Actions">
						<CommandItem
							value="toggle-dark-mode"
							onSelect={() =>
								runAction(() =>
									setTheme(resolvedTheme === "dark" ? "light" : "dark"),
								)
							}
						>
							{resolvedTheme === "dark" ? (
								<Sun className="mr-2 h-4 w-4" />
							) : (
								<Moon className="mr-2 h-4 w-4" />
							)}
							{resolvedTheme === "dark"
								? "Switch to light mode"
								: "Switch to dark mode"}
						</CommandItem>

						<CommandItem
							value="toggle-ai-panel"
							onSelect={() => runAction(toggleAIPanel)}
						>
							<Bot className="mr-2 h-4 w-4" />
							Toggle AI panel
						</CommandItem>

						<CommandItem
							value="toggle-sidebar"
							onSelect={() => runAction(onToggleSidebar)}
						>
							<PanelLeft className="mr-2 h-4 w-4" />
							Toggle sidebar
						</CommandItem>

						<CommandItem
							value="new-file"
							onSelect={() => runAction(onNewFile)}
						>
							<FilePlus className="mr-2 h-4 w-4" />
							New file
						</CommandItem>

						<CommandItem
							value="copy-path"
							onSelect={() => runAction(onCopyPath)}
						>
							<Copy className="mr-2 h-4 w-4" />
							Copy current file path
						</CommandItem>

						<CommandItem
							value="cycle-view-width"
							onSelect={() => runAction(cycleViewWidth)}
						>
							<AlignCenter className="mr-2 h-4 w-4" />
							<span>
								Change view width{" "}
								<span className="text-muted-foreground">
									({VIEW_WIDTH_LABEL[viewWidth]} → {nextWidthLabel})
								</span>
							</span>
						</CommandItem>
					</CommandGroup>
				)}

				{/* ── File-search mode ────────────────────────────────── */}
				{!isActionMode && (
					<>
						{loading && (
							<div className="px-3 py-2 text-xs text-muted-foreground">
								Searching…
							</div>
						)}
						{!loading && fileQuery.trim() !== "" && results.length === 0 && (
							<CommandEmpty>No matches.</CommandEmpty>
						)}
						{results.length > 0 && (
							<>
								<CommandSeparator />
								<CommandGroup
									heading={
										truncated
											? "Top results (refine query for more)"
											: "Results"
									}
								>
									{results.map((r) => (
										<CommandItem
											key={r.path}
											value={r.path}
											onSelect={() => {
												onOpenFile(r.path);
												setOpen(false);
												setQuery("");
											}}
										>
											<div className="flex min-w-0 flex-col gap-0.5">
												<span className="truncate font-mono text-xs">
													{r.path}
												</span>
												{r.snippet && (
													<span className="truncate text-xs text-muted-foreground">
														<SnippetText html={r.snippet} />
													</span>
												)}
											</div>
										</CommandItem>
									))}
								</CommandGroup>
							</>
						)}
					</>
				)}
			</CommandList>
		</CommandDialog>
	);
}
