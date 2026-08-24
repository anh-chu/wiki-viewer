"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useState } from "react";
import { clientId } from "@/lib/client-id";
import { authHeaders } from "@/lib/proof/client-auth";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";
import { diffWords, type WordDiffPart } from "@/lib/proof/word-diff";
import type { Suggestion } from "@/lib/proof/types";

interface Props {
	path: string;
	suggestion: Suggestion;
	overlapSuggestions: readonly Suggestion[];
	currentMarkdown: string;
	baseRevision: number;
	anchor: { top: number; left: number };
	onClose: () => void;
	onNavigate: (suggestionId: string) => void;
	onSettled: () => void;
	readOnly?: boolean;
}

async function postOp(
	path: string,
	baseRevision: number,
	opType: "suggestion.accept" | "suggestion.reject",
	suggestionId: string,
): Promise<{ ok: boolean; status: number }> {
	const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");
	const response = await wsFetch(`/api/agent/files/${encodedPath}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": clientId(),
			...authHeaders(),
		},
		body: JSON.stringify({
			baseRevision,
			by: "human",
			ops: [{ type: opType, suggestionId }],
		}),
	});
	return { ok: response.ok, status: response.status };
}

export function SuggestionReviewPopover({
	path,
	suggestion,
	overlapSuggestions,
	currentMarkdown,
	baseRevision,
	anchor,
	onClose,
	onNavigate,
	onSettled,
	readOnly,
}: Props) {
	const [busy, setBusy] = useState(false);
	const overlapIndex = overlapSuggestions.findIndex(({ id }) => id === suggestion.id);
	const changes = useMemo<WordDiffPart[]>(() => {
		if (suggestion.kind === "delete") {
			return [{ text: currentMarkdown || "(empty)", type: "delete" }];
		}
		if (suggestion.kind === "insertBefore" || suggestion.kind === "insertAfter") {
			return [{ text: suggestion.markdown || "(empty)", type: "insert" }];
		}
		return diffWords(currentMarkdown, suggestion.markdown ?? "");
	}, [currentMarkdown, suggestion]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	async function settle(opType: "suggestion.accept" | "suggestion.reject") {
		if (busy || readOnly) return;
		setBusy(true);
		try {
			let result = await postOp(path, baseRevision, opType, suggestion.id);
			if (!result.ok && result.status === 409 && opType === "suggestion.accept") {
				const latestRevision =
					useProofStore.getState().byPath[path]?.snapshotRevision ?? baseRevision;
				result = await postOp(path, latestRevision, opType, suggestion.id);
			}
		} finally {
			setBusy(false);
			onSettled();
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
					onEscapeKeyDown={onClose}
					onInteractOutside={onClose}
					className="z-50 w-[min(22rem,calc(100vw-1rem))] max-h-[min(28rem,calc(100vh-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl focus:outline-none"
				>
					<div className="flex items-center justify-between gap-2">
						<span className="font-medium text-foreground">Review suggestion</span>
						<span className="truncate font-mono text-[10px] text-muted-foreground/60">
							{suggestion.by}
						</span>
					</div>
					{overlapSuggestions.length > 1 && (
						<div className="mt-2 flex items-center justify-between rounded bg-muted/50 px-2 py-1">
							<span className="text-[10px] text-muted-foreground">
								{overlapIndex + 1} of {overlapSuggestions.length}
							</span>
							<div className="flex items-center gap-1">
								<button
									type="button"
									aria-label="Previous overlapping suggestion"
									disabled={busy}
									onClick={() =>
										onNavigate(
											overlapSuggestions[
												(overlapIndex - 1 + overlapSuggestions.length) % overlapSuggestions.length
											].id,
										)
									}
									className="rounded px-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
								>
									◂
								</button>
								<button
									type="button"
									aria-label="Next overlapping suggestion"
									disabled={busy}
									onClick={() =>
										onNavigate(
											overlapSuggestions[(overlapIndex + 1) % overlapSuggestions.length].id,
										)
									}
									className="rounded px-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
								>
									▸
								</button>
							</div>
						</div>
					)}
					<div className="mt-2">
						<p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
							Changes
						</p>
						<pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/30 px-2 py-1 font-mono text-[11px] text-foreground">
							{changes.map((part, index) => (
								<span
									key={`${part.type}-${index}`}
									className={
										part.type === "delete"
											? "text-destructive line-through"
											: part.type === "insert"
												? "text-success underline decoration-success"
												: "text-muted-foreground"
									}
								>
									{part.text}
								</span>
							))}
						</pre>
					</div>
					{suggestion.basisDetail && (
						<p className="mt-2 italic text-[11px] text-muted-foreground/70">
							{suggestion.basisDetail}
						</p>
					)}
					{!readOnly && (
						<div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-2">
							<button
								type="button"
								disabled={busy}
								onClick={() => void settle("suggestion.reject")}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium hover:bg-accent disabled:opacity-50"
							>
								Reject
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => void settle("suggestion.accept")}
								className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								Accept
							</button>
						</div>
					)}
					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
