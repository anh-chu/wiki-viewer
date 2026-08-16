"use client";

import type { ContentKindAdapter } from "./tweak-types";

/**
 * Shared bottom queue bar. Shows the queued-item count, a per-item remove
 * list, a cancel/deselect path, optional adapter extras (e.g. HTML "Copy as
 * prompt"), and the dispatch button whose label comes from the adapter
 * ("Rewrite" for markdown, "Apply" for HTML).
 */
export function TweakQueueBar({ adapter }: { adapter: ContentKindAdapter }) {
	const { items } = adapter;
	if (!adapter.showQueueBar || items.length === 0) return null;
	return (
		<div className="fixed bottom-4 left-1/2 z-40 flex max-w-[min(40rem,calc(100vw-1rem))] -translate-x-1/2 flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-[12px] shadow-xl">
			<div className="flex items-center gap-3">
				<span className="font-medium text-foreground">
					{items.length} {adapter.countBarNoun}
					{items.length === 1 ? "" : "s"} ready
				</span>
				<button
					type="button"
					onClick={adapter.clear}
					className="rounded-md border border-border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
					title="Clear all queued tweaks"
				>
					Cancel
				</button>
				{adapter.renderQueueBarExtras?.()}
				<button
					type="button"
					disabled={adapter.dispatchDisabled}
					onClick={adapter.onDispatch}
					className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
				>
					{adapter.dispatchLabel}
				</button>
			</div>
			<ul className="space-y-0.5 border-t border-border pt-1.5">
				{items.map((item) => (
					<li
						key={item.itemId}
						className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground"
					>
						<span className="truncate">
							<code className="font-mono">{item.displaySnippet}</code> — {item.instruction}
						</span>
						<button
							type="button"
							onClick={() => adapter.removeItem(item.itemId)}
							className="shrink-0 text-muted-foreground/60 hover:text-foreground"
							title="Remove"
						>
							✕
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
