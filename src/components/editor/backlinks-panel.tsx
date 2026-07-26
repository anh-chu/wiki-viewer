"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Link2, Unlink } from "lucide-react";
import { useEditorStore } from "@/stores/editor-store";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import { useBacklinksStore } from "@/stores/backlinks-store";

/** Display the last two path segments, e.g. "notes/my-page.md" → "notes / my-page" */
function displayPath(filePath: string): string {
	const parts = filePath.replace(/\.md$/i, "").split("/");
	return parts.length > 1 ? parts.slice(-2).join(" / ") : parts[0] ?? filePath;
}

/** Last segment sans .md — the wiki slug used for existence checks. */
function slugFromPath(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	return base.replace(/\.md$/i, "");
}

interface BacklinksPanelProps {
	currentPath: string;
}

/**
 * Collapsed state is remembered across reloads. Key follows the "kb-*"
 * localStorage convention used by editor-store (kb-edit-mode, kb-page-cache).
 */
const COLLAPSED_KEY = "kb-backlinks-collapsed";

export function BacklinksPanel({ currentPath }: BacklinksPanelProps) {
	const [collapsed, setCollapsed] = useState(false);
	const hasSlug = useWikiSlugsStore((s) => s.has);
	const storePath = useBacklinksStore((s) => s.path);
	const storeBacklinks = useBacklinksStore((s) => s.backlinks);
	const loading = useBacklinksStore((s) => s.loading);
	const cacheVersion = useBacklinksStore((s) => s.cacheVersion);

	// Only trust the store's results when they belong to the page we're showing;
	// otherwise the previous page's links flash during navigation.
	const backlinks = storePath === currentPath ? storeBacklinks : [];

	// Read the persisted collapsed flag once, after mount. Doing it in the
	// useState initializer would make the server-rendered markup disagree with
	// the first client render.
	useEffect(() => {
		if (localStorage.getItem(COLLAPSED_KEY) === "1") setCollapsed(true);
	}, []);

	const toggleCollapsed = () => {
		const next = !collapsed;
		setCollapsed(next);
		try {
			localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
		} catch {
			// quota / private-mode errors are non-fatal
		}
	};

	// Fetch only while expanded: a shut panel used to still run a backlinks
	// query on every navigation. Still debounced 200ms so rapid navigation
	// doesn't fire a query per pass-through; the store dedups and aborts.
	// cacheVersion is a dep so a watcher-driven invalidateAll() refreshes an
	// open panel instead of leaving stale links on screen.
	useEffect(() => {
		if (collapsed) return;
		if (!currentPath) return;

		const timer = setTimeout(() => {
			void useBacklinksStore.getState().fetch(currentPath);
		}, 200);

		return () => {
			clearTimeout(timer);
			useBacklinksStore.getState().cancel();
		};
	}, [currentPath, collapsed, cacheVersion]);

	// Only hide when expanded and genuinely empty. While collapsed we must keep
	// the header mounted — returning null there leaves no control to re-expand.
	if (!collapsed && !loading && backlinks.length === 0) return null;

	return (
		<div className="max-w-[var(--editor-max-w,48rem)] mx-auto px-4 sm:px-8 pb-8 pt-1">
			<div className="border-t border-border/60 pt-4">
				<button
					onClick={toggleCollapsed}
					className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors mb-2"
					aria-expanded={!collapsed}
				>
					{collapsed ? (
						<ChevronRight className="h-3 w-3 shrink-0" />
					) : (
						<ChevronDown className="h-3 w-3 shrink-0" />
					)}
					<Link2 className="h-3 w-3 shrink-0" />
					<span className="font-medium">Linked from</span>
					{backlinks.length > 0 && (
						<span className="opacity-50 tabular-nums">({backlinks.length})</span>
					)}
					{loading && <span className="opacity-40 ml-1">…</span>}
				</button>

				{!collapsed && backlinks.length > 0 && (
					<ul className="flex flex-col gap-1.5">
						{backlinks.map((bl) => {
							const exists = hasSlug(slugFromPath(bl.path));
							return (
								<li key={bl.path} className="flex flex-col">
									<button
										onClick={() =>
											exists && useEditorStore.getState().loadPage(bl.path)
										}
										className={
											exists
												? "text-left text-[12px] text-primary/70 hover:text-primary hover:underline underline-offset-2 truncate transition-colors flex items-center gap-1"
												: "text-left text-[12px] text-muted-foreground/40 truncate cursor-default flex items-center gap-1"
										}
										title={
											exists
												? bl.path
												: `${bl.path} (file not found)`
										}
									>
										{!exists && (
											<Unlink className="h-2.5 w-2.5 shrink-0 text-muted-foreground/30" />
										)}
										{displayPath(bl.path)}
									</button>
									{bl.snippet && (
										<p
											className={
												exists
													? "text-[10.5px] text-muted-foreground/50 line-clamp-1 mt-0.5"
													: "text-[10.5px] text-muted-foreground/25 line-clamp-1 mt-0.5"
											}
										>
											{bl.snippet}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}
