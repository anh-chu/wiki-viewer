"use client";

import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Globe,
	Loader2,
	Server,
	Terminal,
	X,
} from "lucide-react";
import { useState } from "react";
import { apiUrl } from "@/lib/url-prefix";
import { cn } from "@/lib/utils";
import { type HostedApp, useHostedAppsStore } from "@/stores/hosted-apps-store";

function appUrl(slug: string): string {
	const path = apiUrl(`/app/${slug}/`);
	if (typeof window === "undefined") return path;
	return `${window.location.origin}${path}`;
}

function displayName(app: HostedApp): string {
	const base = app.relPath.split("/").filter(Boolean).pop();
	return base || app.slug;
}

export function HostedAppsSection() {
	const collapsed = useHostedAppsStore((s) => s.collapsed);
	const toggleCollapsed = useHostedAppsStore((s) => s.toggleCollapsed);
	const apps = useHostedAppsStore((s) => s.apps);
	const loading = useHostedAppsStore((s) => s.loading);
	const loaded = useHostedAppsStore((s) => s.loaded);
	const remove = useHostedAppsStore((s) => s.remove);
	const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

	const copyUrl = async (slug: string) => {
		try {
			await navigator.clipboard.writeText(appUrl(slug));
			setCopiedSlug(slug);
			setTimeout(() => setCopiedSlug((c) => (c === slug ? null : c)), 1200);
		} catch {
			// clipboard may be unavailable; ignore
		}
	};

	return (
		<div className="border-b mb-1">
			<button
				type="button"
				className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
				onClick={toggleCollapsed}
			>
				{collapsed ? (
					<ChevronRight className="h-3 w-3" />
				) : (
					<ChevronDown className="h-3 w-3" />
				)}
				<Server className="h-3 w-3" />
				Hosted Apps
				<span className="ml-auto text-[9px] tabular-nums opacity-60">
					{loaded ? apps.length : ""}
				</span>
			</button>

			{!collapsed && (
				<div className="pb-1">
					{loading && apps.length === 0 ? (
						<div className="flex justify-center py-3">
							<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
						</div>
					) : apps.length === 0 ? (
						<p className="px-3 py-2 text-[11px] text-muted-foreground/70">
							No hosted apps yet. Use “Host this app” from a website
							directory.
						</p>
					) : (
						apps.map((app) => (
							<div
								key={app.slug}
								role="button"
								tabIndex={0}
								className="group flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors select-none hover:bg-muted"
								onClick={() => window.open(appUrl(app.slug), "_blank")}
								onKeyDown={(e) => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										window.open(appUrl(app.slug), "_blank");
									}
								}}
							>
								{app.type === "node" ? (
									<Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
								) : (
									<Globe className="h-3.5 w-3.5 shrink-0 text-sky-500" />
								)}
								<span className="min-w-0 flex-1 truncate text-xs">
									{displayName(app)}
								</span>
								<span className="max-w-[90px] truncate text-[10px] text-muted-foreground/60">
									/{app.slug}
								</span>
								<button
									type="button"
									className="hover-reveal shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:bg-muted hover:text-foreground group-hover:opacity-100 focus:opacity-100"
									title="Copy URL"
									onClick={(e) => {
										e.stopPropagation();
										void copyUrl(app.slug);
									}}
								>
									{copiedSlug === app.slug ? (
										<Check className="h-3 w-3 text-emerald-500" />
									) : (
										<Copy className="h-3 w-3" />
									)}
								</button>
								<button
									type="button"
									className={cn(
										"hover-reveal shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors",
										"hover:bg-muted hover:text-destructive group-hover:opacity-100 focus:opacity-100",
									)}
									title="Unhost"
									onClick={(e) => {
										e.stopPropagation();
										void remove(app.slug);
									}}
								>
									<X className="h-3 w-3" />
								</button>
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}
