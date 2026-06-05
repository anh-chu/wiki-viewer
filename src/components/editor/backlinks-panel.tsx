"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Link2 } from "lucide-react";
import { wsFetch } from "@/lib/workspace-client";
import { useEditorStore } from "@/stores/editor-store";

interface BacklinkEntry {
	path: string;
	snippet: string;
}

function slugFromPath(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	return base.replace(/\.md$/i, "");
}

/**
 * True if `content` contains an actual wiki-link to `slug`, i.e. `[[slug]]`,
 * `[[slug|alias]]`, or `[[slug#anchor]]`. FTS matches tokenised prose, so we
 * re-check the raw text to drop false positives (a page merely mentioning the
 * word, not linking to it).
 */
function hasWikiLinkTo(content: string, slug: string): boolean {
	const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`\\[\\[${esc}(?:\\|[^\\]#|]+|#[a-z0-9-]+)?\\]\\]`, "i");
	return re.test(content);
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

	const slug = slugFromPath(currentPath);

	useEffect(() => {
		if (!slug) return;
		let cancelled = false;
		setLoading(true);
		setBacklinks([]);

		// Search for the slug surrounded by [[ ]] — FTS may not match brackets,
		// but we pass the full pattern; backend uses BM25 on tokenised text so
		// results will include pages that mention the slug near [[ ]].
		// FTS is a coarse candidate filter (it tokenises and strips brackets), so
		// we fetch each candidate's raw content and confirm a literal [[slug]] link.
		(async () => {
			try {
				const r = await wsFetch("/api/wiki/search", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ query: slug, limit: 50 }),
				});
				const d: {
					matches?: Array<{ path: string; score: number; snippet: string }>;
				} = r.ok ? await r.json() : { matches: [] };

				const candidates = (d.matches ?? []).filter(
					(m) => m.path !== currentPath && /\.md$/i.test(m.path),
				);

				const confirmed = await Promise.all(
					candidates.map(async (m) => {
						try {
							const cr = await wsFetch(
								`/api/wiki/content?path=${encodeURIComponent(m.path)}`,
							);
							if (!cr.ok) return null;
							const { content } = (await cr.json()) as { content: string };
							if (!hasWikiLinkTo(content, slug)) return null;
							return { path: m.path, snippet: m.snippet } as BacklinkEntry;
						} catch {
							return null;
						}
					}),
				);

				if (cancelled) return;
				setBacklinks(
					confirmed.filter((b): b is BacklinkEntry => b !== null),
				);
			} catch {
				if (!cancelled) setBacklinks([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [currentPath, slug]);

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
