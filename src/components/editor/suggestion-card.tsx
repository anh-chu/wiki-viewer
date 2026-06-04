"use client";

import { useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import { wsFetch } from "@/lib/workspace-client";
import type { Suggestion } from "@/lib/proof/types";

interface Props {
	suggestion: Suggestion;
	currentMarkdown: string; // current block content for replace diff
	path: string;
	baseRevision: number;
	/** Return the freshest known revision (for 409 retry). */
	getLatestRevision: () => number;
	top: number;
	left: number;
	width: number;
	onSettled: () => void; // called after accept or reject so parent can refresh
}

function kindVerb(kind: Suggestion["kind"]): string {
	switch (kind) {
		case "replace": return "replacing this block";
		case "insertAfter": return "inserting content after this block";
		case "insertBefore": return "inserting content before this block";
		case "delete": return "deleting this block";
	}
}

async function postOp(
	path: string,
	baseRevision: number,
	opType: "suggestion.accept" | "suggestion.reject",
	suggestionId: string,
): Promise<{ ok: boolean; status: number }> {
	const encodedPath = encodeURIComponent(path).replace(/%2F/g, "/");
	const res = await wsFetch(`/api/agent/files/${encodedPath}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": crypto.randomUUID(),
			...authHeaders(),
		},
		body: JSON.stringify({
			baseRevision,
			by: "human",
			ops: [{ type: opType, suggestionId }],
		}),
	});
	return { ok: res.ok, status: res.status };
}

/**
 * Inline suggestion card rendered as an absolutely-positioned sibling to
 * the ProseMirror editor. NOT mounted inside the editor DOM tree.
 *
 * Phase D coordination: this component uses `top`/`left`/`width` computed by
 * the editor's block-ref position tracker. Phase D's comment-pip uses the
 * same tracker (see editor.tsx: useBlockRefPositions).
 */
export function SuggestionCard({
	suggestion,
	currentMarkdown,
	path,
	baseRevision,
	getLatestRevision,
	top,
	left,
	width,
	onSettled,
}: Props) {
	const [busy, setBusy] = useState(false);

	async function handleAccept() {
		if (busy) return;
		setBusy(true);
		try {
			let result = await postOp(path, baseRevision, "suggestion.accept", suggestion.id);
			// On 409 retry once with latest known revision
			if (!result.ok && result.status === 409) {
				result = await postOp(path, getLatestRevision(), "suggestion.accept", suggestion.id);
			}
		} finally {
			setBusy(false);
			onSettled();
		}
	}

	async function handleReject() {
		if (busy) return;
		setBusy(true);
		try {
			await postOp(path, baseRevision, "suggestion.reject", suggestion.id);
		} finally {
			setBusy(false);
			onSettled();
		}
	}

	const isDelete = suggestion.kind === "delete";
	const isInsert = suggestion.kind === "insertAfter" || suggestion.kind === "insertBefore";

	return (
		<div
			style={{
				position: "absolute",
				top,
				left,
				width: width > 0 ? width : undefined,
				zIndex: 30,
			}}
			className="my-1 rounded-lg border border-border bg-card shadow-md text-[12px] overflow-hidden"
			role="region"
			aria-label={`Suggestion by ${suggestion.by}`}
		>
			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border">
				<span className="font-medium text-foreground">
					<span className="text-primary">{suggestion.by}</span>
					{" suggests "}
					<span className="text-muted-foreground">{kindVerb(suggestion.kind)}</span>
				</span>
			</div>

			{/* Body */}
			<div className="p-3 space-y-2">
				{/* replace: two-pane diff */}
				{suggestion.kind === "replace" && (
					<>
						<div>
							<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
								─ current ─
							</p>
							<pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground bg-destructive/5 rounded px-2 py-1">
								{currentMarkdown || "(empty)"}
							</pre>
						</div>
						<div>
							<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
								─ proposed ─
							</p>
							<pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-primary/5 rounded px-2 py-1">
								{suggestion.markdown ?? "(empty)"}
							</pre>
						</div>
					</>
				)}

				{/* insert: proposed content with label */}
				{isInsert && (
					<div>
						<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
							─ will be inserted ─
						</p>
						<pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-primary/5 rounded px-2 py-1">
							{suggestion.markdown ?? "(empty)"}
						</pre>
					</div>
				)}

				{/* delete: current content struck through */}
				{isDelete && (
					<div>
						<p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1">
							─ will be deleted ─
						</p>
						<pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground line-through bg-destructive/5 rounded px-2 py-1">
							{currentMarkdown || "(empty)"}
						</pre>
					</div>
				)}

				{/* Reason */}
				{suggestion.basisDetail && (
					<p className="italic text-muted-foreground/70 text-[11px]">
						Reason: {suggestion.basisDetail}
					</p>
				)}
			</div>

			{/* Actions */}
			<div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-muted/30">
				<button
					type="button"
					disabled={busy}
					onClick={() => void handleAccept()}
					className="flex-1 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
				>
					Accept
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => void handleReject()}
					className="flex-1 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent disabled:opacity-50 transition-colors"
				>
					Reject
				</button>
			</div>
		</div>
	);
}
