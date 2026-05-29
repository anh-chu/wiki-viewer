"use client";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";

type FmValue =
	| string
	| number
	| boolean
	| string[]
	| Record<string, unknown>
	| null;

interface Props {
	data: Record<string, FmValue>;
}

const KNOWN_KEYS = new Set([
	"title",
	"type",
	"status",
	"created",
	"updated",
	"date",
	"tags",
	"sources",
	"private",
	"supersedes",
	"superseded_by",
]);

function fmt(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) return v.map(fmt).join(", ");
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function FrontmatterHeader({ data }: Props) {
	const [showRaw, setShowRaw] = useState(false);
	const keys = Object.keys(data);
	if (keys.length === 0) return null;

	const title = typeof data.title === "string" ? data.title : null;
	const type = typeof data.type === "string" ? data.type : null;
	const status = typeof data.status === "string" ? data.status : null;
	const created = typeof data.created === "string" ? data.created : null;
	const updated = typeof data.updated === "string" ? data.updated : null;
	const isPrivate = data.private === true;
	const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];
	const sources = Array.isArray(data.sources) ? (data.sources as string[]) : [];
	const supersededBy =
		typeof data.superseded_by === "string" ? data.superseded_by : null;

	const otherKeys = keys.filter((k) => !KNOWN_KEYS.has(k));

	return (
		<div className="mb-6 rounded-sm border bg-card/40 px-4 py-3 text-xs">
			{title && (
				<div className="mb-2 text-base font-normal text-foreground">
					{title}
				</div>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground">
				{type && (
					<Badge variant="outline" className="font-normal">
						{type}
					</Badge>
				)}
				{status && (
					<Badge variant="outline" className="font-normal">
						{status}
					</Badge>
				)}
				{isPrivate && (
					<Badge
						variant="outline"
						className="border-warning-ink/40 font-normal text-warning-ink"
					>
						private
					</Badge>
				)}
				{supersededBy && (
					<Badge
						variant="outline"
						className="border-destructive/40 font-normal text-destructive"
					>
						superseded → {supersededBy}
					</Badge>
				)}
				{created && (
					<span>
						<span className="opacity-60">created</span>{" "}
						<span className="text-foreground/80">{created}</span>
					</span>
				)}
				{updated && updated !== created && (
					<span>
						<span className="opacity-60">updated</span>{" "}
						<span className="text-foreground/80">{updated}</span>
					</span>
				)}
			</div>

			{tags.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{tags.map((t) => (
						<Badge
							key={t}
							variant="secondary"
							className="font-normal text-[11px]"
						>
							#{t}
						</Badge>
					))}
				</div>
			)}

			{sources.length > 0 && (
				<div className="mt-2">
					<span className="opacity-60">sources:</span>{" "}
					<span className="text-foreground/80">{sources.join(", ")}</span>
				</div>
			)}

			{otherKeys.length > 0 && (
				<div className="mt-2 border-t pt-2">
					<button
						type="button"
						onClick={() => setShowRaw((v) => !v)}
						className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
					>
						{showRaw ? (
							<ChevronDown className="h-3 w-3" />
						) : (
							<ChevronRight className="h-3 w-3" />
						)}
						<span>
							{otherKeys.length} more field{otherKeys.length === 1 ? "" : "s"}
						</span>
					</button>
					{showRaw && (
						<dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
							{otherKeys.map((k) => (
								<Fragment key={k}>
									<dt className="opacity-60">{k}</dt>
									<dd className="text-foreground/80 break-words">
										{fmt(data[k])}
									</dd>
								</Fragment>
							))}
						</dl>
					)}
				</div>
			)}
		</div>
	);
}
