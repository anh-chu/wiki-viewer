"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";
import type { SuggestionKind } from "@/lib/proof/types";

async function postOp(
	path: string,
	baseRevision: number,
	ops: object[],
): Promise<{ ok: boolean; stale: boolean; newRevision?: number }> {
	const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await wsFetch(`/api/agent/files/${encoded}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": crypto.randomUUID(),
			...authHeaders(),
		},
		body: JSON.stringify({ baseRevision, by: "human", ops }),
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

interface Props {
	path: string;
	blockRef: string;
	/** Current markdown of the block being suggested against. */
	currentMarkdown: string;
	anchor: { top: number; left: number };
	onClose: () => void;
}

const KIND_LABELS: Record<SuggestionKind, string> = {
	replace: "Replace block",
	insertAfter: "Insert after",
	insertBefore: "Insert before",
	delete: "Delete block",
};

export function SuggestEditPopover({ path, blockRef, currentMarkdown, anchor, onClose }: Props) {
	const [kind, setKind] = useState<SuggestionKind>("replace");
	const [markdown, setMarkdown] = useState(currentMarkdown);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Prefill markdown with current block on replace; clear it for inserts.
	useEffect(() => {
		if (kind === "replace") setMarkdown(currentMarkdown);
		else if (kind === "delete") setMarkdown("");
		else setMarkdown("");
	}, [kind, currentMarkdown]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	useEffect(() => {
		setTimeout(() => textareaRef.current?.focus(), 50);
	}, []);

	function getRevision(): number {
		return useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
	}

	const needsMarkdown = kind !== "delete";
	const canSubmit = !busy && (!needsMarkdown || markdown.trim().length > 0);

	async function handleSubmit() {
		if (!canSubmit) return;
		setBusy(true);
		try {
			const op: Record<string, unknown> = {
				type: "suggestion.add",
				ref: blockRef,
				kind,
				basis: "suggested",
			};
			if (needsMarkdown) op.markdown = markdown;
			if (reason.trim()) op.basisDetail = reason.trim();

			let rev = getRevision();
			let result = await postOp(path, rev, [op]);
			if (!result.ok && result.stale && result.newRevision !== undefined) {
				await useProofStore.getState().loadSidecar(path);
				rev = result.newRevision;
				result = await postOp(path, rev, [op]);
			}
			if (result.ok) {
				await useProofStore.getState().loadSidecar(path);
				await useProofStore.getState().loadSnapshot(path);
				onClose();
			}
		} finally {
			setBusy(false);
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
					className="z-50 w-[min(20rem,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-xl p-3 space-y-2.5 text-[12px] focus:outline-none"
				>
					{/* Header */}
					<div className="flex items-center justify-between">
						<span className="font-medium text-foreground">Suggest an edit</span>
						<span className="text-[11px] font-mono text-muted-foreground/60 truncate ml-2">
							{blockRef}
						</span>
					</div>

					{/* Kind selector */}
					<div className="flex flex-wrap gap-1">
						{(Object.keys(KIND_LABELS) as SuggestionKind[]).map((k) => (
							<button
								key={k}
								type="button"
								onClick={() => setKind(k)}
								className={`px-2 py-0.5 rounded-md text-[10.5px] border transition-colors ${
									kind === k
										? "bg-primary text-primary-foreground border-primary"
										: "border-border text-muted-foreground hover:bg-accent"
								}`}
							>
								{KIND_LABELS[k]}
							</button>
						))}
					</div>

					{/* Delete preview */}
					{kind === "delete" && (
						<pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground line-through bg-destructive/5 rounded px-2 py-1 max-h-32 overflow-y-auto">
							{currentMarkdown || "(empty)"}
						</pre>
					)}

					{/* Markdown editor */}
					{needsMarkdown && (
						<div className="space-y-1">
							<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
								{kind === "replace" ? "proposed content" : "content to insert"}
							</p>
							<textarea
								ref={textareaRef}
								value={markdown}
								onChange={(e) => setMarkdown(e.target.value)}
								rows={4}
								placeholder="Markdown…"
								className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
							/>
						</div>
					)}

					{/* Reason */}
					<input
						type="text"
						value={reason}
						onChange={(e) => setReason(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSubmit();
						}}
						placeholder="Reason (optional)"
						className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
					/>

					{/* Actions */}
					<div className="flex items-center justify-between pt-0.5">
						<span className="text-[10px] text-muted-foreground/40">⌘↵ submit</span>
						<div className="flex items-center gap-2">
							<button
								type="button"
								disabled={busy}
								onClick={onClose}
								className="px-2.5 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent disabled:opacity-50 transition-colors"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								onClick={() => void handleSubmit()}
								className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
							>
								Suggest
							</button>
						</div>
					</div>

					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
