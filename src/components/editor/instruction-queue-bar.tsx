"use client";

import { clientId } from "@/lib/client-id";
import { ListChecks, Loader2, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import type { Comment } from "@/lib/proof/types";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";

interface Props {
	path: string;
	/** Draft instructions for the current file (kind === "instruction", state draft). */
	drafts: Comment[];
}

type Phase =
	| { kind: "idle" }
	| { kind: "confirm" }
	| { kind: "sending" }
	| { kind: "sent"; detached: boolean }
	| { kind: "conflict" }
	| { kind: "error"; message: string };

function instructionText(c: Comment): string {
	return c.turns[0]?.text ?? "";
}

/**
 * File-level queue bar: shows "N instructions ready · Send to agent".
 * Clicking enumerates the drafts and, on confirm, POSTs one batch run to
 * /api/wiki/live/request (kind:"generate"), then marks each draft sent with the
 * returned runId via comment.mark.
 */
export function InstructionQueueBar({ path, drafts }: Props) {
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [attached, setAttached] = useState<boolean | null>(null);

	useEffect(() => {
		if (phase.kind !== "confirm") return;
		let alive = true;
		void (async () => {
			try {
				const res = await wsFetch("/api/wiki/live/status");
				if (!alive) return;
				const body = (await res.json()) as { attached: boolean };
				setAttached(body.attached);
			} catch {
				if (alive) setAttached(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [phase.kind]);

	if (drafts.length === 0) return null;

	/**
	 * Resolve the file's current revision at send time. The proof store may not be
	 * hydrated yet (e.g. view mode opened moments ago), so fetch the live snapshot
	 * and fall back to the store only if the network read fails. Sending a stale 0
	 * would make every batch fail closed with STALE_REVISION.
	 */
	async function getRevision(): Promise<number> {
		const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
		try {
			const res = await wsFetch(`/api/agent/files/${encoded}`, {
				headers: authHeaders(),
			});
			if (res.ok) {
				const snap = (await res.json()) as { revision?: number };
				if (typeof snap.revision === "number") return snap.revision;
			}
		} catch {
			/* fall through to store */
		}
		return useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
	}

	async function markSent(runId: string): Promise<boolean> {
		const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
		const ops = drafts.map((c) => ({
			type: "comment.mark",
			commentId: c.id,
			instructionState: "sent",
			runId,
		}));
		let rev = await getRevision();
		const send = () =>
			wsFetch(`/api/agent/files/${encoded}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": clientId(),
					...authHeaders(),
				},
				body: JSON.stringify({ baseRevision: rev, by: "human", ops }),
			});
		let res = await send();
		if (res.status === 409) {
			const data = (await res.json().catch(() => ({}))) as {
				code?: string;
				snapshot?: { revision?: number };
			};
			if (data.code === "STALE_REVISION" && data.snapshot?.revision !== undefined) {
				await useProofStore.getState().loadSidecar(path);
				rev = data.snapshot.revision;
				res = await send();
			}
		}
		await useProofStore.getState().loadSidecar(path);
		return res.ok;
	}

	async function handleSend() {
		setPhase({ kind: "sending" });
		try {
			const rev = await getRevision();
			const items = drafts.map((c) => ({
				instructionId: c.id,
				blockRef: c.ref ?? null,
				baseRevision: rev,
				instruction: instructionText(c),
			}));
			const res = await wsFetch("/api/wiki/live/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path, kind: "generate", items }),
			});
			if (res.status === 409) {
				setPhase({ kind: "conflict" });
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				setPhase({ kind: "error", message: body.message ?? "Send failed" });
				return;
			}
			const body = (await res.json()) as { runId?: string | null };
			// The run is enqueued server-side. If we cannot mark the drafts sent, warn
			// the user rather than claim success: unmarked drafts would otherwise be
			// re-sent as a duplicate run once this one resolves.
			const marked = body.runId ? await markSent(body.runId) : false;
			if (!marked) {
				setPhase({
					kind: "error",
					message:
						"Sent, but could not update the queue. Reload before sending again to avoid duplicates.",
				});
				return;
			}
			setPhase({ kind: "sent", detached: attached === false });
			setTimeout(() => setPhase({ kind: "idle" }), attached === false ? 2200 : 1400);
		} catch (e) {
			setPhase({ kind: "error", message: (e as Error).message });
		}
	}

	return (
		<>
			<div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40">
				<button
					type="button"
					onClick={() => setPhase({ kind: "confirm" })}
					className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-amber-600 text-white text-[12px] font-medium shadow-lg hover:bg-amber-700 transition-colors"
				>
					<ListChecks className="w-4 h-4" />
					<span>
						{drafts.length} instruction{drafts.length === 1 ? "" : "s"} ready · Send to agent
					</span>
				</button>
			</div>

			{phase.kind !== "idle" && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
					onClick={() => {
						if (phase.kind === "confirm") setPhase({ kind: "idle" });
					}}
				>
					<div
						className="w-[min(30rem,calc(100vw-2rem))] bg-popover border border-border rounded-lg shadow-xl p-4 space-y-3 text-[13px]"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center justify-between">
							<span className="flex items-center gap-2 font-medium text-foreground">
								<ListChecks className="w-4 h-4 text-amber-600" />
								Send {drafts.length} instruction{drafts.length === 1 ? "" : "s"} to agent
							</span>
							<button
								type="button"
								onClick={() => setPhase({ kind: "idle" })}
								className="text-muted-foreground/60 hover:text-foreground"
								aria-label="Close"
							>
								<X className="w-4 h-4" />
							</button>
						</div>

						<ol className="space-y-2 max-h-64 overflow-y-auto pr-1 list-decimal list-inside">
							{drafts.map((c) => (
								<li key={c.id} className="space-y-0.5">
									<span className="text-foreground whitespace-pre-wrap">
										{instructionText(c)}
									</span>
									<span className="block text-[11px] font-mono text-muted-foreground/60">
										{c.ref ?? "(no block)"}
									</span>
								</li>
							))}
						</ol>

						{attached === false && phase.kind === "confirm" && (
							<p className="text-[11.5px] text-amber-600">
								No agent attached. Instructions will queue and run when an agent connects.
							</p>
						)}
						{phase.kind === "sent" && (
							<p className="text-[11.5px] text-green-600">
								{phase.detached
									? "Queued. It will run when an agent attaches."
									: "Sent to agent."}
							</p>
						)}
						{phase.kind === "conflict" && (
							<p className="text-[11.5px] text-amber-600">
								A run is already outstanding. Wait for it to resolve before sending again.
							</p>
						)}
						{phase.kind === "error" && (
							<p className="text-[11.5px] text-destructive">{phase.message}</p>
						)}

						{(phase.kind === "confirm" || phase.kind === "sending") && (
							<div className="flex items-center justify-end gap-2 pt-1">
								<button
									type="button"
									onClick={() => setPhase({ kind: "idle" })}
									className="px-3 py-1.5 rounded-md border border-border text-[12px] font-medium hover:bg-accent transition-colors"
								>
									Cancel
								</button>
								<button
									type="button"
									disabled={phase.kind === "sending"}
									onClick={() => void handleSend()}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-[12px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
								>
									{phase.kind === "sending" ? (
										<Loader2 className="w-3.5 h-3.5 animate-spin" />
									) : (
										<Send className="w-3.5 h-3.5" />
									)}
									Send to agent
								</button>
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}
