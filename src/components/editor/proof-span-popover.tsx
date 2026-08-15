"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";

interface SpanMeta {
	spanId: string;
	origin: string | null;
	basis: string | null;
	basisDetail: string | null;
	by: string | null;
	at: string | null;
}

function readMeta(el: HTMLElement): SpanMeta {
	return {
		spanId: el.getAttribute("id") ?? "",
		origin: el.getAttribute("origin"),
		basis: el.getAttribute("basis"),
		basisDetail: el.getAttribute("basis-detail"),
		by: el.getAttribute("by"),
		at: el.getAttribute("at"),
	};
}

function timeAgo(iso: string | null): string {
	if (!iso) return "";
	const diff = Date.now() - new Date(iso).getTime();
	const secs = Math.floor(diff / 1000);
	if (secs < 60) return `${secs}s ago`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.floor(hrs / 24)}d ago`;
}

interface Props {
	targetEl: HTMLElement | null;
	onClose: () => void;
	onComment?: () => void;
}

export function ProofSpanPopover({ targetEl, onClose, onComment }: Props) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [meta, setMeta] = useState<SpanMeta | null>(null);

	useEffect(() => {
		if (!targetEl) {
			setAnchor(null);
			setMeta(null);
			return;
		}
		const rect = targetEl.getBoundingClientRect();
		setAnchor({ top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX });
		setMeta(readMeta(targetEl));
	}, [targetEl]);

	useEffect(() => {
		if (!targetEl) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [targetEl, onClose]);

	if (!targetEl || !anchor || !meta) return null;

	return (
		<Popover.Root open>
			<Popover.Anchor asChild>
				<span
					aria-hidden="true"
					style={{
						position: "fixed",
						top: anchor.top,
						left: anchor.left,
						width: 0,
						height: 0,
						pointerEvents: "none",
					}}
				/>
			</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					collisionPadding={8}
					onInteractOutside={onClose}
					className="z-50 w-[min(16rem,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-xl p-3 space-y-2 text-[12px] focus:outline-none"
				>
					<div className="space-y-0.5">
						<p className="font-medium text-foreground truncate">
							{meta.by ?? "unknown"} · {meta.basis ?? "—"} · {timeAgo(meta.at)}
						</p>
						{meta.basisDetail && (
							<p className="text-muted-foreground italic truncate">
								&ldquo;{meta.basisDetail}&rdquo;
							</p>
						)}
						{meta.origin && (
							<p className="text-muted-foreground/60">origin: {meta.origin}</p>
						)}
					</div>
					{onComment && <button type="button" onClick={() => { onComment(); onClose(); }} className="mt-1 w-full rounded-md border border-border py-1 text-[11px] font-medium hover:bg-accent">Comment</button>}
					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
