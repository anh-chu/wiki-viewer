"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Link2 } from "lucide-react";
import { wsFetch } from "@/lib/workspace-client";
import { useEditorStore } from "@/stores/editor-store";

interface BacklinkEntry {
	path: string;
	snippet: string;
}

/** Display the last two path segments, e.g. "notes/my-page.md" → "notes / my-page" */
function displayPath(filePath: string): string {
	const parts = filePath.replace(/\.md$/i, "").split("/");
	return parts.length > 1 ? parts.slice(-2).join(" / ") : parts[0] ?? filePath;
}

interface BacklinksPanelProps {
	currentPath: string;
}

export function BacklinksPanel({ currentPath }: BacklinksPanelProps) {
	const [backlinks, setBacklinks] = useState<BacklinkEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [collapsed, setCollapsed] = useState(false);

	useEffect(() => {
		if (!currentPath) return;
		let cancelled = false;
		setLoading(true);
		setBacklinks([]);

		// Debounced + single server-side resolution: rapid navigation shouldn't
		// fire a backlinks query per pass-through. Backend runs FTS and confirms
		// literal [[slug]] links against indexed body text in-process.
		const timer = setTimeout(() => {
			(async () => {
				try {
					const r = await wsFetch(
						`/api/wiki/backlinks?path=${encodeURIComponent(currentPath)}`,
					);
					const d: { backlinks?: BacklinkEntry[] } = r.ok
						? await r.json()
						: { backlinks: [] };
					if (cancelled) return;
					setBacklinks(d.backlinks ?? []);
				} catch {
					if (!cancelled) setBacklinks([]);
				} finally {
					if (!cancelled) setLoading(false);
				}
			})();
		}, 200);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [currentPath]);

	// Hide entirely when loading with no prior results or genuinely empty
	if (!loading && backlinks.length === 0) return null;

	return (
		<div className="max-w-[var(--editor-max-w,48rem)] mx-auto px-4 sm:px-8 pb-8 pt-1">
			<div className="border-t border-border/60 pt-4">
				<button
					onClick={() => setCollapsed((c) => !c)}
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
						{backlinks.map((bl) => (
							<li key={bl.path} className="flex flex-col">
								<button
									onClick={() => useEditorStore.getState().loadPage(bl.path)}
									className="text-left text-[12px] text-primary/70 hover:text-primary hover:underline underline-offset-2 truncate transition-colors"
									title={bl.path}
								>
									{displayPath(bl.path)}
								</button>
								{bl.snippet && (
									<p className="text-[10.5px] text-muted-foreground/50 line-clamp-1 mt-0.5">
										{bl.snippet}
									</p>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
