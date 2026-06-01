"use client";

import type { ActivityEvent } from "@/lib/proof/activity-shared";

function timeAgo(iso: string): string {
	const diff = Math.max(0, Date.now() - new Date(iso).getTime());
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function verbFor(type: string): string {
	const map: Record<string, string> = {
		"block.replace": "replaced",
		"block.insertAfter": "inserted after",
		"block.insertBefore": "inserted before",
		"block.delete": "deleted",
		"block.append": "appended",
		"block.prepend": "prepended",
		"comment.add": "commented on",
		"comment.reply": "replied to comment",
		"comment.resolve": "resolved comment",
		"comment.reopen": "reopened comment",
		"suggestion.add": "suggested",
		"suggestion.accept": "accepted suggestion",
		"suggestion.reject": "rejected suggestion",
	};
	return map[type] ?? type;
}

export function ActivityRow({ event }: { event: ActivityEvent }) {
	const filename = event.path.split("/").pop() ?? event.path;
	const ref = typeof event["ref"] === "string" ? (event["ref"] as string) : "";

	return (
		<div className="flex flex-col gap-0.5 py-1.5 border-b border-border/50 last:border-0">
			<div className="flex items-baseline justify-between gap-2">
				<span
					className="text-xs font-mono text-foreground/80 truncate"
					title={event.path}
				>
					{filename}
				</span>
				<span className="text-[10px] text-muted-foreground shrink-0">
					{timeAgo(event.at)}
				</span>
			</div>
			<p className="text-[11px] text-muted-foreground truncate">
				<span className="text-foreground/60">{event.by}</span>{" "}
				{verbFor(event.type)}
				{ref && (
					<>
						{" "}
						<span className="font-mono text-[10px] text-muted-foreground/60">{ref}</span>
					</>
				)}
			</p>
		</div>
	);
}
