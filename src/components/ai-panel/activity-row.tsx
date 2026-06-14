"use client";

import { memo, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useEditorStore } from "@/stores/editor-store";
import { wsFetch } from "@/lib/workspace-client";
import type { ActivityEvent } from "@/lib/proof/activity-shared";

type ReviewCounts = Record<string, number>;

type ActivityGroup = {
	path: string;
	filename: string;
	latestAt: string;
	events: ActivityEvent[];
};

function hashString(input: string): number {
	let hash = 0;
	for (let i = 0; i < input.length; i += 1) {
		hash = (hash * 31 + input.charCodeAt(i)) | 0;
	}
	return Math.abs(hash);
}

function agentLabel(agentId: string): string {
	const raw = agentId.split(/[:/]/).pop() ?? agentId;
	const compact = raw.replace(/[^a-z0-9]/gi, "");
	return (compact.slice(0, 2) || raw.slice(0, 2) || "??").toUpperCase();
}

function agentName(agentId: string): string {
	const raw = agentId.split(/[:/]/).pop() ?? agentId;
	return raw.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function agentChipStyle(agentId: string): CSSProperties {
	const hue = hashString(agentId) % 360;
	return {
		backgroundColor: `hsl(${hue} 72% 42%)`,
		color: "white",
	};
}

function timeAgo(iso: string): string {
	const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
	if (diffSeconds < 45) return "just now";

	const steps: Array<[number, Intl.RelativeTimeFormatUnit]> = [
		[60, "second"],
		[60, "minute"],
		[24, "hour"],
		[7, "day"],
	];
	let value = diffSeconds;
	let unit: Intl.RelativeTimeFormatUnit = "second";
	for (const [step, nextUnit] of steps) {
		if (value < step) break;
		value = Math.floor(value / step);
		unit = nextUnit;
	}

	const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "short" });
	return rtf.format(-value, unit).replace(/\s+/g, " ").replace(/\./g, "");
}

function blockCount(event: ActivityEvent): number {
	if (Array.isArray((event as { refs?: unknown }).refs)) {
		return ((event as { refs?: unknown[] }).refs ?? []).length;
	}
	return typeof (event as { ref?: unknown }).ref === "string" ? 1 : 0;
}

function summaryFor(event: ActivityEvent): string {
	const actor = agentName(event.by);
	const kind = event.type;
	const count = blockCount(event);

	if (kind === "block.append" || (kind === "block.inserted" && (event as { position?: string }).position === "end")) {
		return `${actor} appended ${count || 1} block${(count || 1) === 1 ? "" : "s"}`;
	}
	if (kind === "block.prepend" || (kind === "block.inserted" && (event as { position?: string }).position === "start")) {
		return `${actor} prepended ${count || 1} block${(count || 1) === 1 ? "" : "s"}`;
	}
	if (kind === "block.inserted") {
		return `${actor} inserted ${count || 1} block${(count || 1) === 1 ? "" : "s"}`;
	}
	if (kind === "block.replaced" || kind === "file.rawWritten") {
		return `${actor} edited`;
	}
	if (kind === "block.deleted") {
		return `${actor} deleted ${count || 1} block${(count || 1) === 1 ? "" : "s"}`;
	}
	if (kind === "suggestion.added") {
		return `${actor} suggested a change`;
	}
	if (kind === "suggestion.accepted") {
		return `${actor} accepted a suggestion`;
	}
	if (kind === "suggestion.rejected") {
		return `${actor} rejected a suggestion`;
	}
	if (kind === "comment.added") {
		return `${actor} commented`;
	}
	if (kind === "comment.replied") {
		return `${actor} replied`;
	}
	if (kind === "comment.resolved") {
		return `${actor} resolved a comment`;
	}
	if (kind === "comment.reopened") {
		return `${actor} reopened a comment`;
	}
	if (kind === "file.externallyEdited") {
		return `${actor} changed file externally`;
	}
	return `${actor} ${kind.replace(/^\w+\./, "").replace(/([a-z])([A-Z])/g, "$1 $2")}`;
}

function groupActivity(activity: ActivityEvent[]): ActivityGroup[] {
	const groups = new Map<string, ActivityEvent[]>();
	for (const event of activity) {
		const list = groups.get(event.path) ?? [];
		list.push(event);
		groups.set(event.path, list);
	}

	return Array.from(groups.entries())
		.map(([path, events]) => ({
			path,
			filename: path.split("/").pop() ?? path,
			latestAt: events[0]?.at ?? "",
			events,
		}))
		.sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));
}

function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}

async function fetchReviewCount(path: string): Promise<number> {
	if (!isMarkdownPath(path)) return 0;

	const endpoints = [`/api/agent/sidecar/${path}`, `/api/agent/files/${path}/pending`, `/api/agent/files/${path}`];
	for (const endpoint of endpoints) {
		try {
			const res = await wsFetch(endpoint);
			if (!res.ok) continue;
			const data = (await res.json()) as Record<string, unknown>;

			if (Array.isArray(data.pending)) return data.pending.length;
			if (Array.isArray(data.events) && endpoint.includes("/pending")) return data.events.length;
			if (typeof data.pendingCount === "number") return data.pendingCount;
			if (typeof data.count === "number") return data.count;
			if (typeof data.total === "number") return data.total;
			if (Array.isArray(data.suggestions) || Array.isArray(data.comments) || data.blockProvenance) {
				const suggestions = Array.isArray(data.suggestions)
					? data.suggestions.filter(
						(item) => item && typeof item === "object" && (item as { status?: string }).status === "pending",
					).length
					: 0;
				const comments = Array.isArray(data.comments)
					? data.comments.filter(
						(item) => item && typeof item === "object" && !(item as { resolved?: boolean }).resolved,
					).length
					: 0;
				const proofSpans = data.blockProvenance && typeof data.blockProvenance === "object"
					? Object.keys(data.blockProvenance as Record<string, unknown>).length
					: 0;
				return suggestions + comments + proofSpans;
			}
		} catch {
			// Ignore fetch errors; review badge stays hidden.
		}
	}
	return 0;
}

function ActivityItemImpl({ event }: { event: ActivityEvent }) {
	return (
		<div className="flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-background/50">
			<div
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold shadow-sm ring-1 ring-black/5"
				style={agentChipStyle(event.by)}
				title={event.by}
				aria-hidden
			>
				{agentLabel(event.by)}
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate text-xs text-foreground/85">
					{summaryFor(event)}
				</p>
				<p className="truncate text-[10px] text-muted-foreground">{timeAgo(event.at)}</p>
			</div>
		</div>
	);
}

const ActivityItem = memo(ActivityItemImpl);

function ActivityGroupView({ group, reviewCount }: { group: ActivityGroup; reviewCount: number }) {
	const loadPage = useEditorStore((s) => s.loadPage);
	const latest = group.events[0];

	return (
		<section className="space-y-1.5 rounded-md border border-border/70 bg-background/50 p-2">
			<div className="flex items-start justify-between gap-2">
				<button
					type="button"
					onClick={() => void loadPage(group.path)}
					className="min-w-0 text-left"
					title={group.path}
				>
					<p className="truncate text-xs font-medium text-foreground/90">{group.filename}</p>
					<p className="truncate text-[10px] text-muted-foreground">{group.path}</p>
				</button>
				<div className="flex shrink-0 items-center gap-1.5">
					{reviewCount > 0 && (
						<button
							type="button"
							onClick={() => void loadPage(group.path)}
							className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-500/15"
							title="Open file for review"
						>
							review {reviewCount}
						</button>
					)}
					<span className="text-[10px] text-muted-foreground">{timeAgo(latest.at)}</span>
				</div>
			</div>
			<div className="space-y-0.5">
				{group.events.map((event) => (
					<ActivityItem key={`${event.path}-${event.id}`} event={event} />
				))}
			</div>
		</section>
	);
}

export function ActivityFeed({ activity }: { activity: ActivityEvent[] }) {
	const groups = useMemo(() => groupActivity(activity), [activity]);
	const [reviewCounts, setReviewCounts] = useState<ReviewCounts>({});

	useEffect(() => {
		let cancelled = false;
		const paths = Array.from(new Set(groups.map((group) => group.path)));
		if (paths.length === 0) {
			setReviewCounts({});
			return () => {
				cancelled = true;
			};
		}

		void (async () => {
			const pairs = await Promise.all(
				paths.map(async (path) => [path, await fetchReviewCount(path)] as const),
			);
			if (cancelled) return;
			setReviewCounts(Object.fromEntries(pairs.filter(([, count]) => count > 0)));
		})();

		return () => {
			cancelled = true;
		};
	}, [groups]);

	if (groups.length === 0) {
		return <p className="py-2 text-xs text-muted-foreground/60">No events recorded</p>;
	}

	return (
		<div className="space-y-2">
			{groups.map((group) => (
				<ActivityGroupView
					key={group.path}
					group={group}
					reviewCount={reviewCounts[group.path] ?? 0}
				/>
			))}
		</div>
	);
}
