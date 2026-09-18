"use client";

import { clientId } from "@/lib/client-id";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";
import type { Comment, LineAnchor, ProofEvent, Snapshot, TextRangeAnchor } from "@/lib/proof/types";

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

function applyLocalResult(path: string, op: Record<string, unknown>, snapshot?: Snapshot): void {
	if (!snapshot) return;
	const type = String(op.type);
	const event: ProofEvent = { id: snapshot.lastEventId, type: type.replace("comment.", "comment.").replace("comment.add", "comment.added").replace("comment.reply", "comment.replied").replace("comment.edit", "comment.edited").replace("comment.delete", "comment.deleted").replace("comment.resolve", "comment.resolved").replace("comment.reopen", "comment.reopened"), at: new Date().toISOString(), by: "human", revision: snapshot.revision };
	const commentId = typeof op.commentId === "string" ? op.commentId : undefined;
	if (commentId) event.commentId = commentId;
	if (typeof op.text === "string") event.text = op.text;
	if (type === "comment.add") {
		const comment = snapshot.comments.at(-1);
		if (comment) event.comment = comment;
	}
	useProofStore.getState().applyEvent(path, event);
}

async function postOp(
	path: string,
	baseRevision: number,
	by: string,
	ops: object[],
): Promise<{ ok: boolean; stale: boolean; newRevision?: number; snapshot?: Snapshot }> {
	const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await wsFetch(`/api/agent/files/${encoded}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": clientId(),
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
	return { ok: true, stale: false, snapshot: (await res.json()) as Snapshot };
}

// ── component ────────────────────────────────────────────────────────────────

interface Props {
	path: string;
	anchorKey: string;
	anchorLabel?: string;
	anchorRef?: string;
	lineAnchor?: LineAnchor;
	/**
	 * Exact-text range for a NEW comment created from a selection. Block-scoped
	 * (`ref`), it lets the highlight land on the commented words instead of the
	 * whole block, and it is what makes the anchor findable later if the block
	 * is edited out from under it.
	 */
	textAnchor?: TextRangeAnchor;
	/** Existing comments on this anchor (may be empty = new-comment mode). */
	comments: Comment[];
	anchorEl: HTMLElement | null;
	onClose: () => void;
	/**
	 * `popover` (legacy) floats a Radix popover next to the anchor.
	 * `margin` renders the same thread as a card inside the right-hand margin
	 * column, which is how Google Docs presents comments. Only the positioning
	 * differs — every affordance and operation is shared, so the two can never
	 * drift.
	 */
	variant?: "popover" | "margin";
	/** Margin variant: highlight while the pointer is over the card. */
	onHoverChange?: (hovered: boolean) => void;
}

// Annotation ops are sidecar-only (they never touch the file), so the thread
// keeps full Edit/Delete/Escalate/Resolve affordances in view mode too.
export function CommentThread({ path, anchorKey, anchorLabel, anchorRef, lineAnchor, textAnchor, comments, anchorEl, onClose, variant = "popover", onHoverChange }: Props) {
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
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
				: lineAnchor
					? { type: "comment.add", lineAnchor, text: text.trim() }
					: {
							type: "comment.add",
							ref: anchorRef ?? anchorKey,
							text: text.trim(),
							// Only a brand-new block comment carries the range; a reply or
							// a line-anchored comment must not re-anchor the thread.
							...(textAnchor ? { textAnchor } : {}),
						};

			let rev = getRevision();
			let result = await postOp(path, rev, "human", [sendOp]);
			if (!result.ok && result.stale && result.newRevision !== undefined) {
				// Retry once with fresh revision
				await useProofStore.getState().loadSidecar(path);
				rev = result.newRevision;
				result = await postOp(path, rev, "human", [sendOp]);
			}
			if (result.ok) {
				applyLocalResult(path, sendOp, result.snapshot);
				setText("");
			}
		} finally {
			setBusy(false);
		}
	}

	async function handleEscalate() {
		// Turn an existing comment into a NEW instruction on the same block, carrying
		// the comment text + a backlink. The original comment is left unchanged (R3).
		if (!activeComment || busy) return;
		const text = activeComment.turns.map((t) => t.text).join("\n\n").trim();
		if (!text) return;
		setBusy(true);
		try {
			const op = {
				type: "comment.add",
				ref: activeComment.ref ?? anchorRef ?? anchorKey,
				text,
				kind: "instruction",
				fromCommentId: activeComment.id,
			};
			let rev = getRevision();
			let result = await postOp(path, rev, "human", [op]);
			if (!result.ok && result.stale && result.newRevision !== undefined) {
				await useProofStore.getState().loadSidecar(path);
				rev = result.newRevision;
				result = await postOp(path, rev, "human", [op]);
			}
			if (result.ok) {
				applyLocalResult(path, op, result.snapshot);
			}
		} finally {
			setBusy(false);
		}
	}

	async function handleEdit() {
		if (!activeComment || !editText.trim() || busy) return;
		setBusy(true);
		try {
			const op = { type: "comment.edit", commentId: activeComment.id, text: editText.trim() };
			const result = await postOp(path, getRevision(), "human", [op]);
			if (result.ok) {
				await useProofStore.getState().loadSidecar(path);
				setEditing(false);
			}
		} finally { setBusy(false); }
	}

	async function handleDelete() {
		if (!activeComment || busy || !window.confirm("Delete this comment thread?")) return;
		setBusy(true);
		try {
			const result = await postOp(path, getRevision(), "human", [{ type: "comment.delete", commentId: activeComment.id }]);
			if (result.ok) { await useProofStore.getState().loadSidecar(path); onClose(); }
		} finally { setBusy(false); }
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
				applyLocalResult(path, { type: opType, commentId: activeComment.id }, result.snapshot);
			}
		} finally {
			setBusy(false);
		}
	}

	// Collect all turns from all comments on this block for display
	const allTurns = comments.flatMap((c) =>
		c.turns.map((t) => ({ ...t, resolved: c.resolved, commentId: c.id })),
	);

	// One body, two positionings. Nothing inside depends on which is used, which
	// is deliberate: the popover and the margin card must never diverge in what
	// they let you do.
	const body = (
		<>
					{/* Header */}
					<div className="flex items-center justify-between">
						<span className="flex items-center gap-1.5 min-w-0">
							{activeComment?.kind === "instruction" && (
								<span className="shrink-0 text-[9.5px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-amber-500/15 text-amber-700">
									Instruction
								</span>
							)}
							<span className="text-[11px] font-mono text-muted-foreground/60 truncate">
								{anchorLabel ?? anchorKey}
							</span>
						</span>
						{activeComment && (
							<span className="ml-2 shrink-0 flex items-center gap-1">
								{activeComment.turns[0] && (
									<button type="button" disabled={busy} onClick={() => { setEditing(true); setEditText(activeComment.turns[0].text); }} className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50">Edit</button>
								)}
								<button type="button" disabled={busy} onClick={() => void handleDelete()} className="text-[10px] px-1.5 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 disabled:opacity-50">Delete</button>
								{activeComment.kind !== "instruction" && (
									<button
										type="button"
										disabled={busy}
										onClick={() => void handleEscalate()}
										className="text-[10px] px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-700 hover:bg-amber-500/10 disabled:opacity-50 transition-colors"
										title="Turn into an instruction"
									>
										Turn into an instruction
									</button>
								)}
								<button
									type="button"
									disabled={busy}
									onClick={() => void handleResolveToggle()}
									className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent disabled:opacity-50 transition-colors"
								>
									{activeComment.resolved ? "Reopen" : "Resolve"}
								</button>
							</span>
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
									{editing && t.commentId === activeComment?.id && i === 0 ? (
										<div className="space-y-1"><textarea ref={editing ? textareaRef : undefined} value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleEdit(); }} rows={2} className="w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-[12px]" /><button type="button" disabled={busy || !editText.trim()} onClick={() => void handleEdit()} className="px-2 py-1 rounded bg-primary text-primary-foreground text-[10px]">Save</button></div>
									) : <p className="text-foreground leading-snug whitespace-pre-wrap">{t.text}</p>}
								</div>
							))}
						</div>
					)}

					{/* Reply / new comment footer */}
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
		</>
	);

	if (variant === "margin") {
		return (
			<div
				onMouseEnter={() => onHoverChange?.(true)}
				onMouseLeave={() => onHoverChange?.(false)}
				className="rounded-lg border border-border bg-popover p-3 space-y-2 text-[12px] shadow-sm focus-within:ring-1 focus-within:ring-ring"
			>
				{body}
			</div>
		);
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
					className="z-50 w-[min(18rem,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-xl p-3 space-y-2 text-[12px] focus:outline-none"
				>
					{body}
					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
