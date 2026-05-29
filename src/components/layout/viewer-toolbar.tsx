"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Simplified toolbar stub used by the ported viewer components.
// Replace with a fuller implementation if navigation breadcrumbs are needed.

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
