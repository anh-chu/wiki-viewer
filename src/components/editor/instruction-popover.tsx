"use client";

import { clientId } from "@/lib/client-id";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "@/lib/proof/client-auth";
import { useProofStore } from "@/stores/proof-store";
import { wsFetch } from "@/lib/workspace-client";

interface Props {
	path: string;
	blockRef: string;
	/** Current markdown of the selected block (shown as context). */
	currentMarkdown: string;
	anchor: { top: number; left: number };
	/** Human's exact highlighted substring (precise pointing), if any. */
	selectionText?: string | null;
	onClose: () => void;
}

type Status =
	| { phase: "idle" }
	| { phase: "saving" }
	| { phase: "error"; message: string };

/**
 * Create a DRAFT instruction (agent work order) on the selected block. Unlike
 * the retired ask-agent flow, this never dispatches a live request — it writes a
 * `kind:"instruction"` comment via the existing tier-2 path. Instructions
 * accumulate into the file-level queue and are sent together via "Send to agent".
 */
export function InstructionPopover({
	path,
	blockRef,
	currentMarkdown,
	anchor,
	selectionText = null,
	onClose,
}: Props) {
	const [instruction, setInstruction] = useState("");
	const [status, setStatus] = useState<Status>({ phase: "idle" });
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		setTimeout(() => textareaRef.current?.focus(), 50);
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	function getRevision(): number {
		return useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
	}

	const canSubmit = status.phase !== "saving" && instruction.trim().length > 0;

	async function handleSubmit() {
		if (!canSubmit) return;
		setStatus({ phase: "saving" });
		try {
			const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
			const op = {
				type: "comment.add",
				ref: blockRef,
				text: instruction.trim(),
				kind: "instruction",
			};
			let rev = getRevision();
			const send = () =>
				wsFetch(`/api/agent/files/${encoded}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": clientId(),
						...authHeaders(),
					},
					body: JSON.stringify({ baseRevision: rev, by: "human", ops: [op] }),
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
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				setStatus({ phase: "error", message: body.message ?? "Could not save instruction" });
				return;
			}
			await useProofStore.getState().loadSidecar(path);
			onClose();
		} catch (e) {
			setStatus({ phase: "error", message: (e as Error).message });
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
					className="z-50 w-[min(22rem,calc(100vw-1rem))] bg-popover border border-border rounded-lg shadow-xl p-3 space-y-2.5 text-[12px] focus:outline-none"
				>
					<div className="flex items-center gap-1.5">
						<span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
						<span className="font-medium text-foreground">Instruct</span>
						<span className="text-[10.5px] text-muted-foreground/70">
							· queued, not sent yet
						</span>
					</div>

					{selectionText && (
						<div className="space-y-0.5">
							<span className="text-[10.5px] font-medium text-muted-foreground/70">
								Pointing at:
							</span>
							<pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1 max-h-24 overflow-y-auto">
								{selectionText}
							</pre>
						</div>
					)}

					<pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground bg-muted/40 rounded px-2 py-1 max-h-24 overflow-y-auto">
						{currentMarkdown || "(empty block)"}
					</pre>

					<textarea
						ref={textareaRef}
						value={instruction}
						onChange={(e) => setInstruction(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSubmit();
						}}
						rows={3}
						placeholder="What should the agent do with this block?"
						className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
					/>

					{status.phase === "error" && (
						<p className="text-[11px] text-destructive">{status.message}</p>
					)}

					<div className="flex items-center justify-between pt-0.5">
						<span className="text-[10px] text-muted-foreground/40">⌘↵ save</span>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onClose}
								className="px-2.5 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent transition-colors"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								onClick={() => void handleSubmit()}
								className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
							>
								Add instruction
							</button>
						</div>
					</div>

					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
