"use client";

/**
 * Command palette (cmd+k / ctrl+k) for full-text search.
 * Mounts once in the app shell; visibility is driven by the search store.
 */
import { useEffect } from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { useSearchStore } from "@/stores/search-store";
import { SnippetText } from "./snippet-text";

export function SearchCommandDialog({
	onOpenFile,
}: {
	onOpenFile: (relPath: string) => void;
}) {
	const open = useSearchStore((s) => s.open);
	const setOpen = useSearchStore((s) => s.setOpen);
	const query = useSearchStore((s) => s.query);
	const setQuery = useSearchStore((s) => s.setQuery);
	const results = useSearchStore((s) => s.results);
	const loading = useSearchStore((s) => s.loading);
	const truncated = useSearchStore((s) => s.truncated);
	const search = useSearchStore((s) => s.search);

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

	// Debounced search as the query changes while the palette is open.
	useEffect(() => {
		if (!open) return;
		const id = setTimeout(() => {
			void search(query);
		}, 120);
		return () => clearTimeout(id);
	}, [query, open, search]);

	return (
		<CommandDialog
			open={open}
			onOpenChange={setOpen}
			// cmdk's built-in fuzzy filter would re-rank our BM25 results; disable it.
			shouldFilter={false}
		>
			<CommandInput
				placeholder="Search files…"
				value={query}
				onValueChange={setQuery}
			/>
			<CommandList>
				{loading && (
					<div className="px-3 py-2 text-xs text-muted-foreground">
						Searching…
					</div>
				)}
				{!loading && query.trim() !== "" && results.length === 0 && (
					<CommandEmpty>No matches.</CommandEmpty>
				)}
				{results.length > 0 && (
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
				)}
			</CommandList>
		</CommandDialog>
	);
}
