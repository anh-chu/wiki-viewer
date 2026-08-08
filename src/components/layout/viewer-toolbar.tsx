"use client";

import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// Context for portal-based toolbar slots: leaf viewers (nested inside viewer-pane's
// header) render their sublabel/actions into the right-hand slot and their file-type
// badge into the left-hand slot (next to the path), merging into a single header row.
// Standalone viewers (NodeAppViewer, WebsiteViewer fullscreen) get null for both and
// render their own full self-contained toolbar bar.
export const ViewerToolbarSlotContext = createContext<HTMLElement | null>(null);
export const ViewerToolbarBadgeSlotContext = createContext<HTMLElement | null>(null);

export function ViewerToolbar({
	path,
	badge,
	sublabel,
	showBreadcrumb: _showBreadcrumb = true,
	leading,
	children,
	className,
}: {
	path?: string;
	badge?: string;
	sublabel?: string;
	showBreadcrumb?: boolean;
	leading?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	const slotEl = useContext(ViewerToolbarSlotContext);
	const badgeSlotEl = useContext(ViewerToolbarBadgeSlotContext);

	// Nested mode: portal sublabel/actions into the right-hand slot, and the
	// badge into the left-hand slot (next to the path) if one is available.
	if (slotEl) {
		return (
			<>
				{badge &&
					(badgeSlotEl
						? createPortal(
								<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground/50">
									{badge}
								</span>,
								badgeSlotEl,
							)
						: createPortal(
								<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground/50">
									{badge}
								</span>,
								slotEl,
							))}
				{createPortal(
					<>
						{sublabel && (
							<span className="shrink-0 text-xs text-muted-foreground/40">
								{sublabel}
							</span>
						)}
						{children}
					</>,
					slotEl,
				)}
			</>
		);
	}

	// Standalone mode: render full bar with path and actions
	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-2",
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				{leading}
				{path && (
					<span className="text-xs text-muted-foreground truncate" title={path}>
						{path.split("/").pop() ?? path}
					</span>
				)}
				{badge && (
					<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground/50">
						{badge}
					</span>
				)}
				{sublabel && (
					<span className="shrink-0 text-xs text-muted-foreground/40">
						{sublabel}
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-1">{children}</div>
		</div>
	);
}
