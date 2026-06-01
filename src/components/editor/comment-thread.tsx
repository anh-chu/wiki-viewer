"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import { useProofStore } from "@/stores/proof-store";
import type { Comment } from "@/lib/proof/types";

// ── helpers ──────────────────────────────────────────────────────────────────

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function relTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const secs = Math.round(diff / 1000);
	if (Math.abs(secs) < 60) return rtf.format(-secs, "second");
	const mins = Math.round(secs / 60);
	if (Math.abs(mins) < 60) return rtf.format(-mins, "minute");
	const hrs = Math.round(mins / 60);
	if (Math.abs(hrs) < 24) return rtf.format(-hrs, "hour");
	return rtf.format(-Math.round(hrs / 24), "day");
}

async function postOp(
	path: string,
	baseRevision: number,
	by: string,
	ops: object[],
): Promise<{ ok: boolean; stale: boolean; newRevision?: number }> {
	const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await fetch(`/api/agent/files/${encoded}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": crypto.randomUUID(),
			...authHeaders(),
		},
		body: JSON.stringify({ baseRevision, by, ops }),
	});
	if (res.status === 409) {
		const data = (await res.json()) as { code?: string; snapshot?: { revision?: number } };
		if (data.code === "STALE_REVISION" && data.snapshot?.revision !== undefined) {
			return { ok: false, stale: true, newRevision: data.snapshot.revision };
		}
		return { ok: false, stale: false };
	}
	if (!res.ok) return { ok: false, stale: false };
	return { ok: true, stale: false };
}

// ── component ────────────────────────────────────────────────────────────────

interface Props {
	path: string;
	blockRef: string;
	/** Existing comments on this block (may be empty = new-comment mode). */
	comments: Comment[];
	anchorEl: HTMLElement | null;
	onClose: () => void;
}

export function CommentThread({ path, blockRef, comments, anchorEl, onClose }: Props) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const openComments = comments.filter((c) => !c.resolved);
	const hasOpen = openComments.length > 0;
	// Use first open comment for reply/resolve; fall back to any comment
	const activeComment = openComments[0] ?? comments[0] ?? null;

	useEffect(() => {
		if (!anchorEl) {
			setAnchor(null);
			return;
		}
		const rect = anchorEl.getBoundingClientRect();
		setAnchor({ top: rect.bottom + 4, left: rect.left });
	}, [anchorEl]);

	useEffect(() => {
		if (!anchorEl) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [anchorEl, onClose]);

	useEffect(() => {
		if (anchor) {
			setTimeout(() => textareaRef.current?.focus(), 50);
		}
	}, [anchor]);

	if (!anchorEl || !anchor) return null;

	function getRevision(): number {
		const entry = useProofStore.getState().byPath[path];
		return entry?.snapshotRevision ?? 0;
	}

	async function handleSend() {
		if (!text.trim() || busy) return;
		setBusy(true);
		try {
			const sendOp = activeComment
				? { type: "comment.reply", commentId: activeComment.id, text: text.trim() }
				: { type: "comment.add", ref: blockRef, text: text.trim() };

			let rev = getRevision();
			let result = await postOp(path, rev, "human", [sendOp]);
			if (!result.ok && result.stale && result.newRevision !== undefined) {
				// Retry once with fresh revision
				await useProofStore.getState().loadSidecar(path);
				rev = result.newRevision;
				result = await postOp(path, rev, "human", [sendOp]);
			}
			if (result.ok) {
				await useProofStore.getState().loadSidecar(path);
				setText("");
				onClose();
			}
		} finally {
			setBusy(false);
		}
	}

	async function handleResolveToggle() {
		if (!activeComment || busy) return;
		setBusy(true);
		try {
			const opType = activeComment.resolved ? "comment.reopen" : "comment.resolve";
			let rev = getRevision();
			let result = await postOp(path, rev, "human", [
				{ type: opType, commentId: activeComment.id },
			]);
			if (!result.ok && result.stale && result.newRevision !== undefined) {
				await useProofStore.getState().loadSidecar(path);
				rev = result.newRevision;
				result = await postOp(path, rev, "human", [
					{ type: opType, commentId: activeComment.id },
				]);
			}
			if (result.ok) {
				await useProofStore.getState().loadSidecar(path);
				onClose();
			}
		} finally {
			setBusy(false);
		}
	}

	// Collect all turns from all comments on this block for display
	const allTurns = comments.flatMap((c) =>
		c.turns.map((t) => ({ ...t, resolved: c.resolved, commentId: c.id })),
	);

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
					className="z-50 w-[min(18rem,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-xl p-3 space-y-2 text-[12px] focus:outline-none"
				>
					{/* Header */}
					<div className="flex items-center justify-between">
						<span className="text-[11px] font-mono text-muted-foreground/60 truncate">
							{blockRef}
						</span>
						{activeComment && (
							<button
								type="button"
								disabled={busy}
								onClick={() => void handleResolveToggle()}
								className="ml-2 shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50 transition-colors"
							>
								{activeComment.resolved ? "Reopen" : "Resolve"}
							</button>
						)}
					</div>

					{/* Turns */}
					{allTurns.length > 0 && (
						<div className="space-y-2 max-h-48 overflow-y-auto pr-1">
							{allTurns.map((t, i) => (
								<div key={i} className="space-y-0.5">
									<p className="text-[10px] text-muted-foreground/60">
										{t.by} · {relTime(t.at)}
									</p>
									<p className="text-foreground leading-snug whitespace-pre-wrap">{t.text}</p>
								</div>
							))}
						</div>
					)}

					{/* Reply / new comment footer */}
					{(!activeComment?.resolved || comments.length === 0) && (
						<div className="space-y-1.5 pt-1">
							<textarea
								ref={textareaRef}
								value={text}
								onChange={(e) => setText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										void handleSend();
									}
								}}
								placeholder={
									hasOpen ? "Reply…" : "Add a comment…"
								}
								rows={2}
								className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
							/>
							<div className="flex items-center justify-between">
								<span className="text-[10px] text-muted-foreground/40">⌘↵ send</span>
								<button
									type="button"
									disabled={busy || !text.trim()}
									onClick={() => void handleSend()}
									className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
								>
									Send
								</button>
							</div>
						</div>
					)}

					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
