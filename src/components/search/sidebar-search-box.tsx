"use client";

/**
 * Persistent sidebar search box. Renders an inline results dropdown under the
 * input. Shares state with the cmd+k palette via the search store.
 * Supports keyboard navigation: ArrowUp / ArrowDown to move, Enter to open,
 * Escape to clear.
 */
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useSearchStore } from "@/stores/search-store";
import { SnippetText } from "./snippet-text";

export function SidebarSearchBox({
	onOpenFile,
}: {
	onOpenFile: (relPath: string) => void;
}) {
	const query = useSearchStore((s) => s.query);
	const setQuery = useSearchStore((s) => s.setQuery);
	const results = useSearchStore((s) => s.results);
	const loading = useSearchStore((s) => s.loading);
	const search = useSearchStore((s) => s.search);
	const clear = useSearchStore((s) => s.clear);

	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement>(null);

	// Reset / clamp the highlighted row whenever the result set changes.
	useEffect(() => {
		setActive(0);
	}, [results]);

	// Keep the active row scrolled into view.
	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-idx="${active}"]`,
		);
		el?.scrollIntoView({ block: "nearest" });
	}, [active]);

	function openAt(idx: number) {
		const r = results[idx];
		if (!r) return;
		onOpenFile(r.path);
		clear();
	}

	return (
		<div className="flex flex-col gap-1 px-2 py-1.5">
			<div className="relative">
				<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
				<input
					type="text"
					className="w-full rounded-sm border bg-transparent py-1 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
					placeholder="Search… (⌘K)"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						void search(e.target.value);
					}}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							clear();
							return;
						}
						if (results.length === 0) return;
						if (e.key === "ArrowDown") {
							e.preventDefault();
							setActive((i) => (i + 1) % results.length);
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							setActive((i) => (i - 1 + results.length) % results.length);
						} else if (e.key === "Enter") {
							e.preventDefault();
							openAt(active);
						}
					}}
				/>
			</div>
			{query.trim() !== "" && (
				<div
					ref={listRef}
					className="max-h-64 overflow-y-auto rounded-sm border bg-popover"
				>
					{loading && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							Searching…
						</div>
					)}
					{!loading && results.length === 0 && (
						<div className="px-2 py-1 text-xs text-muted-foreground">
							No matches
						</div>
					)}
					{results.map((r, idx) => (
						<button
							key={r.path}
							type="button"
							data-idx={idx}
							onClick={() => openAt(idx)}
							onMouseEnter={() => setActive(idx)}
							className={`block w-full px-2 py-1 text-left ${
								idx === active ? "bg-accent" : "hover:bg-accent"
							}`}
						>
							<div className="truncate font-mono text-xs">
								{r.path}
							</div>
							{r.snippet && (
								<div className="truncate text-[10px] text-muted-foreground">
									<SnippetText html={r.snippet} />
								</div>
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
