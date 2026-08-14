"use client";

import { clientId } from "@/lib/client-id";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import type { Comment } from "@/lib/proof/types";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";

interface Props {
	path: string;
	/** Sent instructions for the current file (have a runId). */
	sent: Comment[];
	scrollContainer: HTMLElement | null;
}

/**
 * Batch review of an agent run. v1 is all-or-nothing over the proof-spans the
 * run produced.
 *
 * Correlation: the agent stamps every op in a run with the same
 * in-response-to="live:<requestId>" and rides the runId in basis-detail as
 * "[run:<runId>]" (BlockOp has no dedicated run field). We therefore scope a
 * run's spans by matching that "[run:<runId>]" tag in the rendered span's
 * basis-detail attribute. Spans without the tag are left untouched.
 *
 * v1 all-or-nothing is best-effort: proof-spans commit one at a time (there is
 * no multi-span transaction), so on the first failure we STOP and reload rather
 * than continue and scatter partial state. True atomic rollback across spans is
 * a documented non-goal for v1.
 */
export function RunReviewBar({ path, sent, scrollContainer }: Props) {
	const [busy, setBusy] = useState(false);

	if (sent.length === 0) return null;

	// Group sent instructions by runId.
	const runs = new Map<string, Comment[]>();
	for (const c of sent) {
		const rid = c.runId;
		if (!rid) continue;
		const list = runs.get(rid) ?? [];
		list.push(c);
		runs.set(rid, list);
	}
	if (runs.size === 0) return null;

	async function resolveRun(runId: string, action: "accept" | "revert") {
		if (busy) return;
		setBusy(true);
		try {
			const root = scrollContainer ?? document;
			const tag = `[run:${runId}]`;
			const spans = Array.from(
				root.querySelectorAll<HTMLElement>("proof-span[basis-detail], .proof-span[basis-detail]"),
			).filter((el) => (el.getAttribute("basis-detail") ?? "").includes(tag));
			for (const span of spans) {
				const spanId = span.getAttribute("id");
				if (!spanId) continue;
				const res = await wsFetch("/api/agent/internal/span", {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authHeaders() },
					body: JSON.stringify({
						path,
						spanId,
						action,
						idempotencyKey: clientId(),
					}),
				});
				// Fail-stop: do not keep resolving the rest of the run on error, which
				// would leave partial state without any signal.
				if (!res.ok) break;
			}
			await useProofStore.getState().loadSidecar(path);
			await useProofStore.getState().loadSnapshot(path);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="fixed bottom-4 right-4 z-40 space-y-2">
			{Array.from(runs.entries()).map(([runId, instr]) => (
				<div
					key={runId}
					className="flex items-center gap-2 px-3 py-2 rounded-lg bg-popover border border-border shadow-lg text-[12px]"
				>
					<span className="font-mono text-muted-foreground/70">{runId}</span>
					<span className="text-muted-foreground/60">
						· {instr.length} instruction{instr.length === 1 ? "" : "s"}
					</span>
					<button
						type="button"
						disabled={busy}
						onClick={() => void resolveRun(runId, "accept")}
						className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
					>
						<Check className="w-3.5 h-3.5" /> Accept run
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => void resolveRun(runId, "revert")}
						className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent disabled:opacity-50 transition-colors"
					>
						<X className="w-3.5 h-3.5" /> Discard run
					</button>
				</div>
			))}
		</div>
	);
}
