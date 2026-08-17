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
import { deriveHtmlTargetKey } from "../html-target-key";
import { TWEAK_DISPATCH_LABELS } from "../tweak-queue";
import { useTweakSession } from "../use-tweak-session";
import type { ContentKindAdapter } from "../tweak-types";

export interface HtmlAdapterProps {
	frameRef: RefObject<HTMLIFrameElement | null>;
	path: string;
	enabled: boolean;
	onClose: () => void;
}

interface Pick {
	id: string;
	selector: string;
	elementPath: string;
	tag: string;
	snippet: string;
	text: string;
	rect: PickerRect;
}

/** Per-target metadata not carried on the shared TweakItem. */
interface ItemMeta {
	selector: string;
	tag: string;
	snippet: string;
	text: string;
}

type Phase =
	| { kind: "idle" }
	| { kind: "note" }
	| { kind: "confirm" }
	| { kind: "sending" }
	| { kind: "waiting" }
	| { kind: "ready" }
	| { kind: "resolving" }
	| { kind: "variantsWaiting" }
	| { kind: "variants"; items: VariantView[]; selected: string }
	| { kind: "message"; text: string; visualOnly?: boolean };

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
	items: unknown[] | null;
	itemPreviews: ItemPreview[] | null;
	variants: VariantView[] | null;
}

/**
 * HTML content-kind adapter (web-tweak). Pins instructions to N elements (no
 * dispatch), then a single "Apply" run reviews the whole run. Preserves the
 * element picker, DOM-op preview, variants side-path, copy-as-prompt,
 * connect-an-agent and 409/422 handling of the original overlay. The queue now
 * lives in the shared session, which dedups by target so re-picking the same
 * element updates rather than stacking.
 */
export function useHtmlTweakAdapter(props: HtmlAdapterProps): ContentKindAdapter {
	const { frameRef, path, enabled, onClose } = props;
	const session = useTweakSession({ attached: false });
	const { items, addItem, removeItem } = session;

	const [pick, setPick] = useState<Pick | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [note, setNote] = useState("");
	const [acceptable, setAcceptable] = useState(false);
	const [patchSummary, setPatchSummary] = useState<string | null>(null);
	const [affectedFiles, setAffectedFiles] = useState<string[]>([]);
	const [agent, setAgent] = useState<{ attached: boolean; name: string | null }>({
		attached: false,
		name: null,
	});
	const [copied, setCopied] = useState(false);
	const [promptModal, setPromptModal] = useState<string | null>(null);

	const metaRef = useRef<Map<string, ItemMeta>>(new Map());
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

	/** Close the note editor without changing picker chrome (e.g. after pinning). */
	const dismissPickEditor = useCallback(() => {
		setPick(null);
		setNote("");
		setPhase({ kind: "idle" });
	}, []);

	/** Cancel the current pick: remove its badge/mark in the iframe, then close. */
	const clearPick = useCallback(() => {
		if (pick) {
			postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "remove", id: pick.id });
		}
		dismissPickEditor();
	}, [pick, frameRef, dismissPickEditor]);

	const resetRun = useCallback(() => {
		stopPolling();
		for (const id of appliedIdsRef.current) {
			postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "revert", id });
		}
		postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "clear" });
		appliedIdsRef.current = [];
		variantsTargetIdRef.current = null;
		previewIdRef.current = null;
		metaRef.current.clear();
		session.clear();
		setPick(null);
		setNote("");
		setAcceptable(false);
		setPatchSummary(null);
		setAffectedFiles([]);
		setPhase({ kind: "idle" });
	}, [stopPolling, frameRef, session]);

	// Presence poll.
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
				setPhase((prev) =>
					prev.kind === "idle" || prev.kind === "note"
						? (() => {
								setPick({
									id: msg.id,
									selector: msg.selector,
									elementPath: msg.elementPath,
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

	function buildPrompt(): string {
		const lines = [`Edit the file \`${path}\` (an HTML page). Apply these changes:`, ""];
		if (items.length === 0 && pick) {
			lines.push(`1. Element \`${pick.selector}\` (<${pick.tag}>): ${note.trim()}`);
		} else {
			items.forEach((q, i) => {
				const m = metaRef.current.get(q.targetKey);
				lines.push(
					`${i + 1}. Element \`${m?.selector ?? q.displaySnippet}\` (<${m?.tag ?? "?"}>): ${q.instruction}`,
				);
			});
		}
		return lines.join("\n");
	}

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

	/** Pin the current element + instruction to the queue (deduped by target). */
	function handleAddInstruction() {
		if (!pick || note.trim().length === 0) return;
		const targetKey = deriveHtmlTargetKey(pick);
		const itemId = pick.id || `pin_${Date.now().toString(36)}`;
		metaRef.current.set(targetKey, {
			selector: pick.selector,
			tag: pick.tag,
			snippet: pick.snippet,
			text: pick.text,
		});
		addItem({
			targetKey,
			itemId,
			displaySnippet: pick.selector,
			instruction: note.trim(),
		});
		// Keep the badge: it now represents the queued item, so only close the
		// editor (unlike Cancel, which must remove the badge).
		dismissPickEditor();
	}

	async function handleSend() {
		if (items.length === 0) return;
		setPhase({ kind: "sending" });
		try {
			const res = await wsFetch("/api/wiki/web-tweak/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					items: items.map((q) => {
						const m = metaRef.current.get(q.targetKey);
						return {
							instructionId: q.itemId,
							selector: m?.selector ?? q.displaySnippet,
							tag: m?.tag ?? "",
							snippet: m?.snippet ?? "",
							text: m?.text ?? "",
							instruction: q.instruction,
						};
					}),
				}),
			});
			if (res.status === 409) {
				setPhase({
					kind: "message",
					text: "A Proposal is already outstanding. Resolve it first.",
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

	async function handleGetOptions() {
		if (!pick || note.trim().length === 0) return;
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
					text: "A Proposal is already outstanding. Resolve it first.",
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

	const runInFlight =
		phase.kind === "waiting" ||
		phase.kind === "ready" ||
		phase.kind === "resolving" ||
		phase.kind === "sending" ||
		phase.kind === "variantsWaiting" ||
		phase.kind === "variants";

	const frameRect = frameRef.current?.getBoundingClientRect();
	const anchorTop = pick && frameRect ? frameRect.top + pick.rect.bottom : 0;
	const anchorLeft = pick && frameRect ? frameRect.left + pick.rect.left : 0;

	const renderRunPanel = () => {
		if (!enabled) return null;
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
							. Waiting for a Proposal…
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
						{patchSummary && <p className="text-[11px] text-foreground">{patchSummary}</p>}
						{affectedFiles.length > 0 && (
							<ul className="space-y-0.5">
								{affectedFiles.map((f) => (
									<li key={f} className="font-mono text-[10.5px] text-muted-foreground">
										{f}
									</li>
								))}
							</ul>
						)}
						{!acceptable && (
							<p className="text-[11px] text-amber-600">Visual only — cannot accept.</p>
						)}
						<div className="flex items-center justify-end gap-2 pt-0.5">
							<button
								type="button"
								onClick={() => void handleDiscardRun()}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
							>
								Discard
							</button>
							{acceptable && (
								<button
									type="button"
									onClick={() => void handleAcceptRun()}
									className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
								>
									Accept
								</button>
							)}
						</div>
					</>
				)}

				{phase.kind === "variants" &&
					(() => {
						const sel =
							phase.items.find((v) => v.variantId === phase.selected) ?? phase.items[0];
						return (
							<>
								<p className="text-[11px] font-medium text-foreground">
									{phase.items.length} Variant
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
									<p className="text-[11px] text-foreground">{sel.patchSummary}</p>
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
							className={`text-[11px] ${phase.visualOnly ? "text-amber-600" : "text-foreground"}`}
						>
							{phase.text}
						</p>
						<div className="flex items-center justify-end gap-2 pt-0.5">
							{(pick || items.length > 0) && (
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
	};

	const renderTargeting = () => {
		if (!enabled) return null;
		return (
			<>
				{/* Toolbar hint while picking, no active pick and no run in flight. */}
				{!pick && phase.kind !== "confirm" && !runInFlight && (
					<div className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground/85 px-3 py-1 text-[11px] font-medium text-background shadow">
						<span>Target mode — click an element to add a tweak</span>
						<button
							type="button"
							onClick={onClose}
							className="rounded-full px-1.5 text-background/80 transition-colors hover:text-background"
							title="Exit tweak mode"
						>
							✕
						</button>
					</div>
				)}

				{/* Prompt fallback modal. */}
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
								Apply {items.length} tweak{items.length === 1 ? "" : "s"} with{" "}
								{agent.name ?? "the agent"}?
							</div>
							<ol className="max-h-64 space-y-1.5 overflow-y-auto">
								{items.map((q, i) => {
									const m = metaRef.current.get(q.targetKey);
									return (
										<li key={q.itemId} className="flex gap-2">
											<span className="text-muted-foreground">{i + 1}.</span>
											<div className="min-w-0">
												<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
													{m?.selector ?? q.displaySnippet}
												</code>
												<p className="mt-0.5 text-foreground">{q.instruction}</p>
											</div>
										</li>
									);
								})}
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
									Apply
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
							<span className="font-medium text-foreground">Target</span>
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
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleAddInstruction();
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
											? "Ask the agent for several Variants"
											: "No agent is on the line yet"
									}
									onClick={() => void handleGetOptions()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
								>
									Options
								</button>
								<button
									type="button"
									disabled={note.trim().length === 0}
									onClick={handleAddInstruction}
									className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
								>
									Add tweak
								</button>
							</div>
						</div>
						{items.length > 0 && (
							<ul className="space-y-0.5 border-t border-border pt-1.5">
								{items.map((q) => {
									const m = metaRef.current.get(q.targetKey);
									return (
										<li
											key={q.itemId}
											className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground"
										>
											<span className="truncate">
												<code className="font-mono">{m?.selector ?? q.displaySnippet}</code> —{" "}
												{q.instruction}
											</span>
											<button
												type="button"
												onClick={() => removeItem(q.itemId)}
												className="shrink-0 text-muted-foreground/60 hover:text-foreground"
												title="Remove"
											>
												✕
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				)}
			</>
		);
	};

	return {
		contentKind: "html",
		dispatchLabel: agent.attached ? TWEAK_DISPATCH_LABELS.html : "Connect an agent",
		countBarNoun: "tweak",
		items,
		removeItem,
		clear: resetRun,
		showQueueBar: enabled && !runInFlight && phase.kind !== "confirm",
		onDispatch: () => {
			if (agent.attached) setPhase({ kind: "confirm" });
			else useAIPanelStore.getState().open();
		},
		dispatchDisabled: false,
		renderTargeting,
		renderRunPanel,
		renderQueueBarExtras: () => (
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
		),
	};
}
