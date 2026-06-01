"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";

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
	path: string;
	onClose: () => void;
	onComment?: () => void;
}

export function ProofSpanPopover({ targetEl, path, onClose, onComment }: Props) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [meta, setMeta] = useState<SpanMeta | null>(null);
	const [busy, setBusy] = useState(false);

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

	async function sendAction(action: "accept" | "revert") {
		if (busy || !meta) return;
		setBusy(true);
		try {
			await fetch("/api/agent/internal/span", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...authHeaders() },
				body: JSON.stringify({
					path,
					spanId: meta.spanId,
					action,
					idempotencyKey: crypto.randomUUID(),
				}),
			});
		} finally {
			setBusy(false);
			onClose();
		}
	}

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
					<div className="flex items-center gap-1.5 pt-1">
						<button
							type="button"
							disabled={busy}
							onClick={() => void sendAction("accept")}
							className="flex-1 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
						>
							Accept
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => void sendAction("revert")}
							className="flex-1 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent disabled:opacity-50 transition-colors"
						>
							Revert
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => { onComment?.(); onClose(); }}
							className="flex-1 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent disabled:opacity-50 transition-colors"
						>
							Comment
						</button>
					</div>
					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
