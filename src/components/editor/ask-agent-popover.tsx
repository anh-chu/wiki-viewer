"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
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
	/** Best-effort char offset of the substring within the block markdown. */
	selectionStart?: number | null;
	/** Best-effort exclusive end offset. */
	selectionEnd?: number | null;
	onClose: () => void;
}

type Status =
	| { phase: "idle" }
	| { phase: "sending" }
	| { phase: "sent" }
	| { phase: "detached" }
	| { phase: "conflict" }
	| { phase: "error"; message: string };

/**
 * Dispatch a live "generate" request to an attached agent for the selected block.
 * The request only carries intent; the agent's edit lands as a normal proof-span
 * through the existing tier-2 path and appears via the editor's file watch.
 */
export function AskAgentPopover({
	path,
	blockRef,
	currentMarkdown,
	anchor,
	selectionText = null,
	selectionStart = null,
	selectionEnd = null,
	onClose,
}: Props) {
	const [instruction, setInstruction] = useState("");
	const [status, setStatus] = useState<Status>({ phase: "idle" });
	const [attached, setAttached] = useState<boolean | null>(null);
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

	// Check whether an agent is on the line.
	useEffect(() => {
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
	}, []);

	function getRevision(): number {
		return useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
	}

	const canSubmit = status.phase !== "sending" && instruction.trim().length > 0;

	async function handleSubmit() {
		if (!canSubmit) return;
		setStatus({ phase: "sending" });
		try {
			const res = await wsFetch("/api/wiki/live/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					blockRef,
					baseRevision: getRevision(),
					kind: "generate",
					instruction: instruction.trim(),
					selectionText,
					selectionStart,
					selectionEnd,
				}),
			});
			if (res.status === 409) {
				setStatus({ phase: "conflict" });
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				setStatus({ phase: "error", message: body.message ?? "Request failed" });
				return;
			}
			setStatus(attached === false ? { phase: "detached" } : { phase: "sent" });
			// Close shortly after a successful dispatch.
			setTimeout(onClose, attached === false ? 1400 : 900);
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
					<div className="flex items-center justify-between">
						<span className="font-medium text-foreground">Ask agent</span>
						<span className="flex items-center gap-1.5">
							<span
								className={`inline-block w-1.5 h-1.5 rounded-full ${
									attached === true
										? "bg-green-500"
										: attached === false
											? "bg-amber-500"
											: "bg-muted-foreground/40"
								}`}
								aria-hidden="true"
							/>
							<span className="text-[10.5px] text-muted-foreground/70">
								{attached === true
									? "agent attached"
									: attached === false
										? "no agent"
										: "…"}
							</span>
						</span>
					</div>

					{selectionText && (
						<div className="space-y-0.5">
							<span className="text-[10.5px] font-medium text-muted-foreground/70">
								Pointing at:
							</span>
							<pre className="whitespace-pre-wrap font-mono text-[11px] text-foreground bg-primary/10 border border-primary/20 rounded px-2 py-1 max-h-24 overflow-y-auto">
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

					{status.phase === "sent" && (
						<p className="text-[11px] text-green-600">Sent to agent.</p>
					)}
					{status.phase === "detached" && (
						<p className="text-[11px] text-amber-600">
							Queued. It will run when an agent attaches.
						</p>
					)}
					{status.phase === "conflict" && (
						<p className="text-[11px] text-amber-600">
							A request is already in progress. Wait for it to resolve.
						</p>
					)}
					{status.phase === "error" && (
						<p className="text-[11px] text-destructive">{status.message}</p>
					)}

					<div className="flex items-center justify-between pt-0.5">
						<span className="text-[10px] text-muted-foreground/40">⌘↵ send</span>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onClose}
								className="px-2.5 py-1 rounded-md border border-border text-[11px] font-medium hover:bg-accent transition-colors"
							>
								Close
							</button>
							<button
								type="button"
								disabled={!canSubmit}
								onClick={() => void handleSubmit()}
								className="px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
							>
								Send
							</button>
						</div>
					</div>

					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
