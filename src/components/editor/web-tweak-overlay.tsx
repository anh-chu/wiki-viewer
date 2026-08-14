"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { wsFetch } from "@/lib/workspace-client";
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

type Phase =
	| { kind: "idle" }
	| { kind: "note" }
	| { kind: "sending" }
	| { kind: "waiting" }
	| { kind: "ready" }
	| { kind: "resolving" }
	| { kind: "message"; text: string; visualOnly?: boolean };

interface StatusResponse {
	status: "requested" | "preview-ready" | "accepted" | "discarded" | "invalidated";
	selector: string;
	domPreviewOps: DomOp[] | null;
	acceptable: boolean;
	patchSummary: string | null;
	affectedFiles: string[];
}

/**
 * Trusted parent-side overlay driving the web-tweak flow over a rendered iframe.
 *
 * Every iframe->parent message passes through readPickerMessage (identity +
 * schema checked); raw e.data is never trusted. Accept/Discard trigger source
 * writes ONLY via the buttons here — never from a frame message.
 */
export function WebTweakOverlay({ frameRef, path, enabled, onClose }: Props) {
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

	const previewIdRef = useRef<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const resetPick = useCallback(() => {
		stopPolling();
		previewIdRef.current = null;
		setPick(null);
		setNote("");
		setAcceptable(false);
		setPatchSummary(null);
		setAffectedFiles([]);
		setPhase({ kind: "idle" });
	}, [stopPolling]);

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
		if (!enabled) resetPick();
	}, [enabled, frameRef, resetPick]);

	// Listen for trusted picker messages.
	useEffect(() => {
		if (!enabled) return;
		function onMessage(e: MessageEvent) {
			const msg = readPickerMessage(e, frameRef.current);
			if (!msg) return;
			if (msg.event === "ready") {
				// The picker script finished loading inside the frame. The initial
				// enable command may have been posted before this listener existed
				// (srcDoc parse race), so (re)enable now that the picker is live.
				postPickerCommand(frameRef.current, { source: "wv-tweak", cmd: "enable" });
				return;
			}
			if (msg.event === "selected") {
				// A new selection resets any in-flight preview.
				stopPolling();
				previewIdRef.current = null;
				setAcceptable(false);
				setPatchSummary(null);
				setAffectedFiles([]);
				setPick({
					id: msg.id,
					selector: msg.selector,
					tag: msg.tag,
					snippet: msg.snippet,
					text: msg.text,
					rect: msg.rect,
				});
				setNote("");
				setPhase({ kind: "note" });
			}
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [enabled, frameRef, stopPolling]);

	useEffect(() => stopPolling, [stopPolling]);

	useEffect(() => {
		if (phase.kind === "note") setTimeout(() => noteRef.current?.focus(), 50);
	}, [phase.kind]);

	const startPolling = useCallback(
		(previewId: string, pickId: string) => {
			stopPolling();
			const startedAt = Date.now();
			const TIMEOUT_MS = 90_000;
			pollRef.current = setInterval(async () => {
				if (Date.now() - startedAt > TIMEOUT_MS) {
					stopPolling();
					setPhase({
						kind: "message",
						text: "No response from the agent yet. You can keep waiting by re-sending, or copy the prompt and run it elsewhere.",
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
						if (data.domPreviewOps) {
							postPickerCommand(frameRef.current, {
								source: "wv-tweak",
								cmd: "apply",
								id: pickId,
								ops: data.domPreviewOps,
							});
						}
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
						setPhase({ kind: "message", text: `Preview ${data.status}.` });
					}
				} catch {}
			}, 1000);
		},
		[frameRef, stopPolling],
	);

	/** Build a self-contained prompt a human can paste into any agent/chat. */
	function buildPrompt(): string {
		if (!pick) return "";
		return [
			`Edit the file \`${path}\` (an HTML page).`,
			"",
			`Target element (CSS selector): ${pick.selector}`,
			`Tag: <${pick.tag}>`,
			pick.text ? `Current text: ${pick.text}` : "",
			"",
			"Current markup:",
			"```html",
			pick.snippet || "(unavailable)",
			"```",
			"",
			`Requested change: ${note.trim() || "(describe the change)"}`,
		]
			.filter((l) => l !== "")
			.join("\n");
	}

	async function handleCopyPrompt() {
		try {
			await navigator.clipboard.writeText(buildPrompt());
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			setPhase({ kind: "message", text: "Could not access clipboard." });
		}
	}

	async function handleSend() {
		if (!pick || note.trim().length === 0) return;
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
				}),
			});
			if (res.status === 409) {
				setPhase({
					kind: "message",
					text: "A tweak request is already outstanding. Resolve it first.",
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
			startPolling(body.previewId, pick.id);
		} catch (e) {
			setPhase({ kind: "message", text: (e as Error).message });
		}
	}

	async function handleAccept() {
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
				resetPick();
				return;
			}
			if (res.status === 409) {
				if (pick) {
					postPickerCommand(frameRef.current, {
						source: "wv-tweak",
						cmd: "revert",
						id: pick.id,
					});
				}
				setPhase({ kind: "message", text: "Source changed since preview. Re-tweak." });
				return;
			}
			if (res.status === 422) {
				setPhase({
					kind: "message",
					text: "This preview is visual only and cannot be accepted.",
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

	async function handleDiscard() {
		const previewId = previewIdRef.current;
		if (pick) {
			postPickerCommand(frameRef.current, {
				source: "wv-tweak",
				cmd: "revert",
				id: pick.id,
			});
		}
		if (previewId) {
			try {
				await wsFetch("/api/wiki/web-tweak/resolve", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ previewId, action: "discard" }),
				});
			} catch {}
		}
		resetPick();
	}

	if (!enabled) return null;

	// Translate iframe-relative rect into page coordinates for popover anchoring.
	const frameRect = frameRef.current?.getBoundingClientRect();
	const anchorTop = pick && frameRect ? frameRect.top + pick.rect.bottom : 0;
	const anchorLeft = pick && frameRect ? frameRect.left + pick.rect.left : 0;

	return (
		<>
			{/* Toolbar hint while picking, no active pick. */}
			{!pick && (
				<div className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground/85 px-3 py-1 text-[11px] font-medium text-background shadow">
					<span>Tweak mode — click an element to change it</span>
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

			{pick && (
				<div
					className="fixed z-50 w-[min(22rem,calc(100vw-1rem))] space-y-2.5 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl"
					style={{ top: anchorTop + 6, left: anchorLeft }}
				>
					<div className="flex items-center justify-between">
						<span className="font-medium text-foreground">Tweak element</span>
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
							{pick.tag}
						</code>
					</div>

					<pre className="max-h-20 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
						{pick.snippet || pick.selector}
					</pre>

					{(phase.kind === "note" || phase.kind === "sending") && (
						<>
							<textarea
								ref={noteRef}
								value={note}
								onChange={(e) => setNote(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSend();
								}}
								rows={3}
								placeholder="What should change?"
								className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring placeholder:text-muted-foreground/40"
							/>
							{/* Who a Send would reach. */}
							<div className="flex items-center gap-1.5 text-[10.5px]">
								<span
									className={`inline-block h-1.5 w-1.5 rounded-full ${
										agent.attached ? "bg-emerald-500" : "bg-muted-foreground/40"
									}`}
								/>
								{agent.attached ? (
									<span className="text-muted-foreground">
										Sends to <span className="font-medium text-foreground">{agent.name ?? "agent"}</span>
									</span>
								) : (
									<span className="text-amber-600">No agent attached</span>
								)}
							</div>
							{!agent.attached && (
								<p className="text-[10px] text-muted-foreground/70">
									Start one from the{" "}
									<span className="font-medium text-foreground/70">Agents</span> panel
									(“Live collaboration”), or use Copy as prompt to run it in your own
									agent.
								</p>
							)}
							<div className="flex items-center justify-between pt-0.5">
								<span className="text-[10px] text-muted-foreground/40">⌘↵ send</span>
								<div className="flex items-center gap-2">
									<button
										type="button"
										onClick={handleDiscard}
										className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={() => void handleCopyPrompt()}
										title="Copy a self-contained prompt to paste into any agent"
										className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
									>
										{copied ? "Copied" : "Copy as prompt"}
									</button>
									<button
										type="button"
										disabled={
											phase.kind === "sending" ||
										note.trim().length === 0 ||
										!agent.attached
									}
										title={agent.attached ? "Send to the attached agent" : "No agent attached"}
										onClick={() => void handleSend()}
										className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
									>
										{phase.kind === "sending" ? "Sending…" : "Send"}
									</button>
								</div>
							</div>
						</>
					)}

					{phase.kind === "waiting" && (
						<div className="space-y-2">
							<p className="text-[11px] text-muted-foreground">
								Sent to{" "}
								<span className="font-medium text-foreground">
									{agent.name ?? "the agent"}
								</span>
								. Waiting for it to produce a preview…
							</p>
							{!agent.attached && (
								<p className="text-[11px] text-amber-600">
									The agent went offline. It may not respond — you can cancel and
									copy the prompt instead.
								</p>
							)}
							<div className="flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={() => void handleCopyPrompt()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									{copied ? "Copied" : "Copy as prompt"}
								</button>
								<button
									type="button"
									onClick={() => void handleDiscard()}
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
										<li key={f} className="font-mono text-[10.5px] text-muted-foreground">
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
									onClick={() => void handleDiscard()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									Discard
								</button>
								{acceptable && (
									<button
										type="button"
										onClick={() => void handleAccept()}
										className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
									>
										Accept
									</button>
								)}
							</div>
						</>
					)}

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
								<button
									type="button"
									onClick={() => void handleCopyPrompt()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									{copied ? "Copied" : "Copy as prompt"}
								</button>
								<button
									type="button"
									onClick={() => void handleDiscard()}
									className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
								>
									Dismiss
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</>
	);
}
