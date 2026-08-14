"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { wsFetch } from "@/lib/workspace-client";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import {
	type DomOp,
	type PickerRect,
	postPickerCommand,
	readPickerMessage,
} from "@/lib/web-tweak/protocol";

interface Props {
	frameRef: RefObject<HTMLIFrameElement | null>;
	path: string;
	enabled: boolean;
	onClose: () => void;
}

interface Pick {
	id: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	rect: PickerRect;
}

/** A pinned instruction waiting to be sent (no request has fired). */
interface QueuedInstruction {
	instructionId: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	instruction: string;
}

type Phase =
	| { kind: "idle" }
	| { kind: "note" } // element picked, typing an instruction to pin
	| { kind: "confirm" } // enumerated send confirmation
	| { kind: "sending" }
	| { kind: "waiting" }
	| { kind: "ready" }
	| { kind: "resolving" }
	| { kind: "variantsWaiting" } // single-element variants dispatched, awaiting options
	| { kind: "variants"; items: VariantView[]; selected: string }
	| { kind: "message"; text: string; visualOnly?: boolean };

interface WebInstructionItem {
	instructionId: string;
	selector: string;
	tag: string;
	snippet: string;
	text: string;
	instruction: string;
}
interface ItemPreview {
	instructionId: string;
	ops: DomOp[];
}

interface VariantView {
	variantId: string;
	label: string;
	domPreviewOps: DomOp[] | null;
	acceptable: boolean;
	patchSummary: string | null;
	affectedFiles: string[];
}

interface StatusResponse {
	status: "requested" | "preview-ready" | "accepted" | "discarded" | "invalidated";
	selector: string;
	domPreviewOps: DomOp[] | null;
	acceptable: boolean;
	patchSummary: string | null;
	affectedFiles: string[];
	runId: string | null;
	items: WebInstructionItem[] | null;
	itemPreviews: ItemPreview[] | null;
	variants: VariantView[] | null;
}

/**
 * Trusted parent-side overlay driving the web-tweak flow over a rendered iframe.
 *
 * Rhythm: pin instructions to N elements (no dispatch) -> one file-level
 * "Send N to agent" as a single run -> review the whole run (Accept run /
 * Discard run). Write-on-accept engine is unchanged: source stays clean until
 * accept commits the candidate patch through commitCandidate.
 *
 * Every iframe->parent message passes through readPickerMessage (identity +
 * schema checked); raw e.data is never trusted. Accept/Discard trigger source
 * writes ONLY via the buttons here — never from a frame message.
 */
export function WebTweakOverlay({ frameRef, path, enabled, onClose }: Props) {
	const [pick, setPick] = useState<Pick | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [note, setNote] = useState("");
	const [queue, setQueue] = useState<QueuedInstruction[]>([]);
	const [acceptable, setAcceptable] = useState(false);
	const [patchSummary, setPatchSummary] = useState<string | null>(null);
	const [affectedFiles, setAffectedFiles] = useState<string[]>([]);
	const [agent, setAgent] = useState<{ attached: boolean; name: string | null }>({
		attached: false,
		name: null,
	});
	const [copied, setCopied] = useState(false);
	// The prompt text shown in a fallback modal when the clipboard API is
	// unavailable (non-secure context / http remote) or the user asks to see it.
	const [promptModal, setPromptModal] = useState<string | null>(null);

	const previewIdRef = useRef<string | null>(null);
	const appliedIdsRef = useRef<string[]>([]);
	const variantsTargetIdRef = useRef<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	/** Clear the current element pick (not the queue). */
	const clearPick = useCallback(() => {
		setPick(null);
		setNote("");
		setPhase({ kind: "idle" });
	}, []);

	/** Full reset after a run resolves: revert any applied ops, drop queue+run. */
	const resetRun = useCallback(() => {
		stopPolling();
		for (const id of appliedIdsRef.current) {
			postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "revert", id });
		}
		appliedIdsRef.current = [];
		variantsTargetIdRef.current = null;
		previewIdRef.current = null;
		setQueue([]);
		setPick(null);
		setNote("");
		setAcceptable(false);
		setPatchSummary(null);
		setAffectedFiles([]);
		setPhase({ kind: "idle" });
	}, [stopPolling, frameRef]);

	// Presence poll: who (if anyone) is on the live channel for this workspace.
	useEffect(() => {
		if (!enabled) return;
		let alive = true;
		const check = async () => {
			try {
				const res = await wsFetch("/api/wiki/live/status");
				if (!res.ok || !alive) return;
				const data = (await res.json()) as {
					attached: boolean;
					session: { agentName: string | null } | null;
				};
				if (alive)
					setAgent({ attached: data.attached, name: data.session?.agentName ?? null });
			} catch {}
		};
		void check();
		const t = setInterval(check, 3000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [enabled]);

	// Enable/disable the picker inside the frame.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		postPickerCommand(frame, { source: "wv-tweak", cmd: enabled ? "enable" : "disable" });
		if (!enabled) resetRun();
	}, [enabled, frameRef, resetRun]);

	// Listen for trusted picker messages.
	useEffect(() => {
		if (!enabled) return;
		function onMessage(e: MessageEvent) {
			const msg = readPickerMessage(e, frameRef.current);
			if (!msg) return;
			if (msg.event === "ready") {
				postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "enable" });
				return;
			}
			if (msg.event === "selected") {
				// Selecting a new element while a run is in flight is ignored; the run
				// must be resolved first.
				setPhase((prev) =>
					prev.kind === "idle" || prev.kind === "note"
						? (() => {
								setPick({
									id: msg.id,
									selector: msg.selector,
									tag: msg.tag,
									snippet: msg.snippet,
									text: msg.text,
									rect: msg.rect,
								});
								setNote("");
								return { kind: "note" };
							})()
						: prev,
				);
			}
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [enabled, frameRef]);

	useEffect(() => stopPolling, [stopPolling]);

	useEffect(() => {
		if (phase.kind === "note") setTimeout(() => noteRef.current?.focus(), 50);
	}, [phase.kind]);

	const startPolling = useCallback(
		(previewId: string) => {
			stopPolling();
			const startedAt = Date.now();
			const TIMEOUT_MS = 90_000;
			pollRef.current = setInterval(async () => {
				if (Date.now() - startedAt > TIMEOUT_MS) {
					stopPolling();
					setPhase({
						kind: "message",
						text: "No response from the agent yet. You can keep waiting, or copy the prompt and run it elsewhere.",
					});
					return;
				}
				try {
					const res = await wsFetch(
						`/api/wiki/web-tweak/status?previewId=${encodeURIComponent(previewId)}`,
					);
					if (!res.ok) return;
					const data = (await res.json()) as StatusResponse;
					if (data.status === "preview-ready") {
						stopPolling();
						// Apply each instruction's preview ops in-frame. The picker
						// registered each pick under an id === our instructionId, so
						// apply/revert target by instructionId.
						const applied: string[] = [];
						const itemPreviews = data.itemPreviews ?? [];
						for (const ip of itemPreviews) {
							postPickerCommand(frameRef.current, {
								source: "wv-tweak",
								cmd: "apply",
								id: ip.instructionId,
								ops: ip.ops,
							});
							applied.push(ip.instructionId);
						}
						appliedIdsRef.current = applied;
						setAcceptable(data.acceptable);
						setPatchSummary(data.patchSummary);
						setAffectedFiles(data.affectedFiles);
						setPhase({ kind: "ready" });
					} else if (
						data.status === "discarded" ||
						data.status === "invalidated" ||
						data.status === "accepted"
					) {
						stopPolling();
						setPhase({ kind: "message", text: `Run ${data.status}.` });
					}
				} catch {}
			}, 1000);
		},
		[frameRef, stopPolling],
	);

	/** Apply one variant's preview ops in-frame, targeting the picked element. */
	const applyVariant = useCallback(
		(targetId: string, ops: DomOp[] | null) => {
			if (!ops || ops.length === 0) return;
			postPickerCommand(frameRef.current, {
				source: "wv-tweak",
				cmd: "apply",
				id: targetId,
				ops,
			});
			appliedIdsRef.current = [targetId];
		},
		[frameRef],
	);

	/** Revert whatever variant ops are currently applied to the target element. */
	const revertVariant = useCallback(
		(targetId: string) => {
			postPickerCommand(frameRef.current, {
				source: "wv-tweak",
				cmd: "revert",
				id: targetId,
			});
			appliedIdsRef.current = [];
		},
		[frameRef],
	);

	/** Poll status for a single-element variants request. */
	const startVariantsPolling = useCallback(
		(previewId: string, targetId: string) => {
			stopPolling();
			const startedAt = Date.now();
			const TIMEOUT_MS = 90_000;
			pollRef.current = setInterval(async () => {
				if (Date.now() - startedAt > TIMEOUT_MS) {
					stopPolling();
					setPhase({
						kind: "message",
						text: "No response from the agent yet. You can keep waiting, or copy the prompt and run it elsewhere.",
					});
					return;
				}
				try {
					const res = await wsFetch(
						`/api/wiki/web-tweak/status?previewId=${encodeURIComponent(previewId)}`,
					);
					if (!res.ok) return;
					const data = (await res.json()) as StatusResponse;
					if (data.status === "preview-ready") {
						const variants = data.variants ?? [];
						if (variants.length === 0) return;
						stopPolling();
						const first = variants[0];
						applyVariant(targetId, first.domPreviewOps);
						setPhase({
							kind: "variants",
							items: variants,
							selected: first.variantId,
						});
					} else if (
						data.status === "discarded" ||
						data.status === "invalidated" ||
						data.status === "accepted"
					) {
						stopPolling();
						setPhase({ kind: "message", text: `Run ${data.status}.` });
					}
				} catch {}
			}, 1000);
		},
		[stopPolling, applyVariant],
	);

	/** Build a self-contained prompt a human can paste into any agent/chat. */
	function buildPrompt(): string {
		const lines = [`Edit the file \`${path}\` (an HTML page). Apply these changes:`, ""];
		if (queue.length === 0 && pick) {
			lines.push(`1. Element \`${pick.selector}\` (<${pick.tag}>): ${note.trim()}`);
		} else {
			queue.forEach((q, i) => {
				lines.push(`${i + 1}. Element \`${q.selector}\` (<${q.tag}>): ${q.instruction}`);
			});
		}
		return lines.join("\n");
	}

	/** True when the async clipboard API can actually write (needs a secure ctx). */
	function canUseClipboard(): boolean {
		return (
			typeof navigator !== "undefined" &&
			!!navigator.clipboard &&
			typeof navigator.clipboard.writeText === "function" &&
			window.isSecureContext
		);
	}

	async function handleCopyPrompt() {
		const text = buildPrompt();
		// On http remotes the clipboard API is blocked; fall back to a modal the
		// user can select and copy manually instead of failing silently.
		if (!canUseClipboard()) {
			setPromptModal(text);
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setPromptModal(text);
		}
	}

	/** Pin the current element + instruction to the queue. No request fires. */
	function handleAddInstruction() {
		if (!pick || note.trim().length === 0) return;
		setQueue((q) => [
			...q,
			{
				instructionId: pick.id || `pin_${Date.now().toString(36)}`,
				selector: pick.selector,
				tag: pick.tag,
				snippet: pick.snippet,
				text: pick.text,
				instruction: note.trim(),
			},
		]);
		clearPick();
	}

	function removeQueued(instructionId: string) {
		setQueue((q) => q.filter((x) => x.instructionId !== instructionId));
	}

	async function handleSend() {
		if (queue.length === 0) return;
		setPhase({ kind: "sending" });
		try {
			const res = await wsFetch("/api/wiki/web-tweak/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					items: queue.map((q) => ({
						instructionId: q.instructionId,
						selector: q.selector,
						tag: q.tag,
						snippet: q.snippet,
						text: q.text,
						instruction: q.instruction,
					})),
				}),
			});
			if (res.status === 409) {
				setPhase({
					kind: "message",
					text: "A run is already outstanding. Resolve it first.",
				});
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				setPhase({ kind: "message", text: body.message ?? "Request failed." });
				return;
			}
			const body = (await res.json()) as { previewId: string };
			previewIdRef.current = body.previewId;
			setPhase({ kind: "waiting" });
			startPolling(body.previewId);
		} catch (e) {
			setPhase({ kind: "message", text: (e as Error).message });
		}
	}

	/** Dispatch the current single element for N variant options. */
	async function handleGetOptions() {
		if (!pick || note.trim().length === 0) return;
		// The picker always assigns a non-empty id to a selected element, and the
		// in-frame apply/revert commands target that exact id.
		const targetId = pick.id;
		variantsTargetIdRef.current = targetId;
		setPhase({ kind: "sending" });
		try {
			const res = await wsFetch("/api/wiki/web-tweak/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					selector: pick.selector,
					tag: pick.tag,
					snippet: pick.snippet,
					text: pick.text,
					note: note.trim(),
					variants: true,
				}),
			});
			if (res.status === 409) {
				setPhase({
					kind: "message",
					text: "A run is already outstanding. Resolve it first.",
				});
				return;
			}
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { message?: string };
				setPhase({ kind: "message", text: body.message ?? "Request failed." });
				return;
			}
			const body = (await res.json()) as { previewId: string };
			previewIdRef.current = body.previewId;
			setPhase({ kind: "variantsWaiting" });
			startVariantsPolling(body.previewId, targetId);
		} catch (e) {
			setPhase({ kind: "message", text: (e as Error).message });
		}
	}

	/** Switch selected variant: revert previous ops, then apply new ones. */
	function handleSelectVariant(variantId: string) {
		const targetId = variantsTargetIdRef.current;
		if (!targetId) return;
		setPhase((prev) => {
			if (prev.kind !== "variants" || prev.selected === variantId) return prev;
			const next = prev.items.find((v) => v.variantId === variantId);
			if (!next) return prev;
			revertVariant(targetId);
			applyVariant(targetId, next.domPreviewOps);
			return { ...prev, selected: variantId };
		});
	}

	async function handleAcceptVariant() {
		const previewId = previewIdRef.current;
		if (!previewId || phase.kind !== "variants") return;
		const variantId = phase.selected;
		setPhase({ kind: "resolving" });
		try {
			const res = await wsFetch("/api/wiki/web-tweak/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ previewId, action: "accept", variantId }),
			});
			if (res.ok) {
				postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "clear" });
				appliedIdsRef.current = [];
				resetRun();
				return;
			}
			if (res.status === 409) {
				resetRun();
				setPhase({ kind: "message", text: "Source changed since preview. Re-instruct." });
				return;
			}
			if (res.status === 422) {
				setPhase({
					kind: "message",
					text: "This variant is visual only and cannot be accepted.",
					visualOnly: true,
				});
				return;
			}
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			setPhase({ kind: "message", text: body.message ?? "Accept failed." });
		} catch (e) {
			setPhase({ kind: "message", text: (e as Error).message });
		}
	}

	async function handleAcceptRun() {
		const previewId = previewIdRef.current;
		if (!previewId) return;
		setPhase({ kind: "resolving" });
		try {
			const res = await wsFetch("/api/wiki/web-tweak/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ previewId, action: "accept" }),
			});
			if (res.ok) {
				postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "clear" });
				appliedIdsRef.current = [];
				resetRun();
				return;
			}
			if (res.status === 409) {
				resetRun();
				setPhase({ kind: "message", text: "Source changed since preview. Re-instruct." });
				return;
			}
			if (res.status === 422) {
				setPhase({
					kind: "message",
					text: "This run is visual only and cannot be accepted.",
					visualOnly: true,
				});
				return;
			}
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			setPhase({ kind: "message", text: body.message ?? "Accept failed." });
		} catch (e) {
			setPhase({ kind: "message", text: (e as Error).message });
		}
	}

	async function handleDiscardRun() {
		const previewId = previewIdRef.current;
		if (previewId) {
			try {
				await wsFetch("/api/wiki/web-tweak/resolve", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ previewId, action: "discard" }),
				});
			} catch {}
		}
		resetRun();
	}

	if (!enabled) return null;

	const frameRect = frameRef.current?.getBoundingClientRect();
	const anchorTop = pick && frameRect ? frameRect.top + pick.rect.bottom : 0;
	const anchorLeft = pick && frameRect ? frameRect.left + pick.rect.left : 0;

	const runInFlight =
		phase.kind === "waiting" ||
		phase.kind === "ready" ||
		phase.kind === "resolving" ||
		phase.kind === "sending" ||
		phase.kind === "variantsWaiting" ||
		phase.kind === "variants";

	return (
		<>
			{/* Toolbar hint while picking, no active pick and no run in flight. */}
			{!pick && phase.kind !== "confirm" && !runInFlight && (
				<div className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground/85 px-3 py-1 text-[11px] font-medium text-background shadow">
					<span>Instruct mode — click an element to add a change</span>
					<button
						type="button"
						onClick={onClose}
						className="rounded-full px-1.5 text-background/80 transition-colors hover:text-background"
						title="Exit instruct mode"
					>
						✕
					</button>
				</div>
			)}

			{/* File-level queue bar: N instructions ready · Send to agent. */}
			{queue.length > 0 && !runInFlight && phase.kind !== "confirm" && (
				<div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-[12px] shadow-xl">
					<span className="font-medium text-foreground">
						{queue.length} instruction{queue.length === 1 ? "" : "s"} ready
					</span>
					<div className="flex items-center overflow-hidden rounded-md border border-border">
						<button
							type="button"
							onClick={() => void handleCopyPrompt()}
							className="px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
						>
							{copied ? "Copied" : "Copy as prompt"}
						</button>
						<button
							type="button"
							title="Show the prompt to copy manually"
							onClick={() => setPromptModal(buildPrompt())}
							className="border-l border-border px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent"
						>
							Show
						</button>
					</div>
					{agent.attached ? (
						<button
							type="button"
							onClick={() => setPhase({ kind: "confirm" })}
							className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
						>
							Send {queue.length} to agent
						</button>
					) : (
						<button
							type="button"
							title="No agent is on the line yet — set one up to send"
							onClick={() => useAIPanelStore.getState().open()}
							className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
						>
							Connect an agent
						</button>
					)}
				</div>
			)}

			{/* Prompt fallback: shown when the clipboard API is unavailable (http
			    remote) or the user clicks Show. Read-only, auto-selected for manual copy. */}
			{promptModal !== null && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
					<div className="w-[min(34rem,calc(100vw-2rem))] space-y-2 rounded-lg border border-border bg-popover p-4 text-[12px] shadow-xl">
						<div className="font-medium text-foreground">Prompt</div>
						<p className="text-[11px] text-muted-foreground/70">
							Copy this and run it in your agent. (Clipboard access needs an https
							connection, so copy manually here.)
						</p>
						<textarea
							readOnly
							value={promptModal}
							rows={8}
							ref={(el) => el?.select()}
							className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						/>
						<div className="flex items-center justify-end gap-2 pt-1">
							<button
								type="button"
								onClick={() => setPromptModal(null)}
								className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
							>
								Done
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Enumerated send confirmation. */}
			{phase.kind === "confirm" && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
					<div className="w-[min(30rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-border bg-popover p-4 text-[12px] shadow-xl">
						<div className="font-medium text-foreground">
							Send {queue.length} instruction{queue.length === 1 ? "" : "s"} to{" "}
							{agent.name ?? "the agent"}?
						</div>
						<ol className="max-h-64 space-y-1.5 overflow-y-auto">
							{queue.map((q, i) => (
								<li key={q.instructionId} className="flex gap-2">
									<span className="text-muted-foreground">{i + 1}.</span>
									<div className="min-w-0">
										<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
											{q.selector}
										</code>
										<p className="mt-0.5 text-foreground">{q.instruction}</p>
									</div>
								</li>
							))}
						</ol>
						<div className="flex items-center justify-end gap-2 pt-1">
							<button
								type="button"
								onClick={() => setPhase({ kind: "idle" })}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void handleSend()}
								className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
							>
								Send to agent
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Per-element instruction editor (pin to queue). */}
			{pick && phase.kind === "note" && (
				<div
					className="fixed z-50 w-[min(22rem,calc(100vw-1rem))] space-y-2.5 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl"
					style={{ top: anchorTop + 6, left: anchorLeft }}
				>
					<div className="flex items-center justify-between">
						<span className="font-medium text-foreground">Instruct element</span>
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
							{pick.tag}
						</code>
					</div>

					<pre className="max-h-20 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
						{pick.snippet || pick.selector}
					</pre>

					<textarea
						ref={noteRef}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
								handleAddInstruction();
						}}
						rows={3}
						placeholder="What should change?"
						className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
					/>
					<div className="flex items-center justify-between pt-0.5">
						<span className="text-[10px] text-muted-foreground/40">⌘↵ add</span>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={clearPick}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={note.trim().length === 0 || !agent.attached}
								title={
									agent.attached
										? "Ask the agent for several options"
										: "No agent is on the line yet"
								}
								onClick={() => void handleGetOptions()}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
							>
								Get options
							</button>
							<button
								type="button"
								disabled={note.trim().length === 0}
								onClick={handleAddInstruction}
								className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
							>
								Add instruction
							</button>
						</div>
					</div>
					{queue.length > 0 && (
						<ul className="space-y-0.5 border-t border-border pt-1.5">
							{queue.map((q) => (
								<li
									key={q.instructionId}
									className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground"
								>
									<span className="truncate">
										<code className="font-mono">{q.selector}</code> — {q.instruction}
									</span>
									<button
										type="button"
										onClick={() => removeQueued(q.instructionId)}
										className="shrink-0 text-muted-foreground/60 hover:text-foreground"
										title="Remove"
									>
										✕
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{/* Run lifecycle panel (waiting / ready / resolving / message). */}
			{renderRunPanel(phase)}
		</>
	);

	function renderRunPanel(phase: Phase) {
		return runInFlight || phase.kind === "message" ? (
				<div className="fixed bottom-4 left-1/2 z-50 w-[min(24rem,calc(100vw-1rem))] -translate-x-1/2 space-y-2.5 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl">
					{(phase.kind === "sending" ||
						phase.kind === "waiting" ||
						phase.kind === "variantsWaiting") && (
						<div className="space-y-2">
							<p className="text-[11px] text-muted-foreground">
								Sent to{" "}
								<span className="font-medium text-foreground">
									{agent.name ?? "the agent"}
								</span>
								. Waiting for it to produce a preview run…
							</p>
							<div className="flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={() => void handleDiscardRun()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									Cancel
								</button>
							</div>
						</div>
					)}

					{phase.kind === "ready" && (
						<>
							{patchSummary && (
								<p className="text-[11px] text-foreground">{patchSummary}</p>
							)}
							{affectedFiles.length > 0 && (
								<ul className="space-y-0.5">
									{affectedFiles.map((f) => (
										<li
											key={f}
											className="font-mono text-[10.5px] text-muted-foreground"
										>
											{f}
										</li>
									))}
								</ul>
							)}
							{!acceptable && (
								<p className="text-[11px] text-amber-600">
									Visual only — cannot accept.
								</p>
							)}
							<div className="flex items-center justify-end gap-2 pt-0.5">
								<button
									type="button"
									onClick={() => void handleDiscardRun()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									Discard run
								</button>
								{acceptable && (
									<button
										type="button"
										onClick={() => void handleAcceptRun()}
										className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
									>
										Accept run
									</button>
								)}
							</div>
						</>
					)}

					{phase.kind === "variants" &&
						(() => {
							const sel =
								phase.items.find((v) => v.variantId === phase.selected) ??
								phase.items[0];
							return (
								<>
									<p className="text-[11px] font-medium text-foreground">
										{phase.items.length} option
										{phase.items.length === 1 ? "" : "s"}
									</p>
									<div className="flex flex-wrap gap-1.5">
										{phase.items.map((v) => (
											<button
												key={v.variantId}
												type="button"
												onClick={() => handleSelectVariant(v.variantId)}
												className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
													v.variantId === phase.selected
														? "bg-primary text-primary-foreground"
														: "border border-border hover:bg-accent"
												}`}
											>
												{v.label}
											</button>
										))}
									</div>
									{sel?.patchSummary && (
										<p className="text-[11px] text-foreground">
											{sel.patchSummary}
										</p>
									)}
									{sel && !sel.acceptable && (
										<p className="text-[11px] text-amber-600">visual only</p>
									)}
									<div className="flex items-center justify-end gap-2 pt-0.5">
										<button
											type="button"
											onClick={() => void handleDiscardRun()}
											className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
										>
											Discard
										</button>
										{sel?.acceptable && (
											<button
												type="button"
												onClick={() => void handleAcceptVariant()}
												className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
											>
												Accept
											</button>
										)}
									</div>
								</>
							);
						})()}

					{phase.kind === "resolving" && (
						<p className="text-[11px] text-muted-foreground">Working…</p>
					)}

					{phase.kind === "message" && (
						<>
							<p
								className={`text-[11px] ${
									phase.visualOnly ? "text-amber-600" : "text-foreground"
								}`}
							>
								{phase.text}
							</p>
							<div className="flex items-center justify-end gap-2 pt-0.5">
								{(pick || queue.length > 0) && (
									<button
										type="button"
										onClick={() => void handleCopyPrompt()}
										className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
									>
										{copied ? "Copied" : "Copy as prompt"}
									</button>
								)}
								<button
									type="button"
									onClick={() => void handleDiscardRun()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									Dismiss
								</button>
							</div>
						</>
					)}
				</div>
		) : null;
	}
}
