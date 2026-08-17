"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { wsFetch } from "@/lib/workspace-client";
import { useProofStore } from "@/stores/proof-store";
import { useLiveAttached } from "../../live-presence";
import { TWEAK_DISPATCH_LABELS } from "../tweak-queue";
import { useTweakSession } from "../use-tweak-session";
import type { ContentKindAdapter } from "../tweak-types";

export type MarkdownTarget = {
	blockRef: string;
	markdown: string;
	selectionText: string | null;
	selectionStart: number | null;
	selectionEnd: number | null;
};

type BlockPos = { top: number; left: number; width: number; bottom: number };

interface Variant {
	variantId: string;
	label: string;
	markdown: string;
}

/** One dispatched item's live proposal, keyed by server previewId. */
interface RunItem {
	itemId: string;
	blockRef: string;
	previewId: string;
	variants: Variant[];
	selectedIdx: number;
	status: "pending" | "ready" | "invalidated" | "resolved";
}

export interface MarkdownAdapterProps {
	path: string;
	target: MarkdownTarget | null;
	onClose: () => void;
	positions: Map<string, BlockPos>;
	scrollRef: RefObject<HTMLDivElement | null>;
	isViewing: boolean;
	baseRevision: number;
}

/**
 * Markdown content-kind adapter. Gather-then-Rewrite: every tweak is queued
 * (deduped by blockRef) and the whole queue dispatches as one batch run through
 * POST /api/wiki/live/request. Each item then resolves independently through
 * md-status / md-resolve keyed by the server-issued previewId.
 */
export function useMarkdownTweakAdapter(props: MarkdownAdapterProps): ContentKindAdapter {
	const { path, target, onClose, positions, scrollRef, isViewing, baseRevision } = props;
	const attached = useLiveAttached();
	const session = useTweakSession({ attached });

	const [draft, setDraft] = useState("");
	const [runItems, setRunItems] = useState<RunItem[]>([]);
	const [message, setMessage] = useState("");
	const [copied, setCopied] = useState(false);
	const [promptModal, setPromptModal] = useState<string | null>(null);
	// Per-target selectionText captured at add time (not stored on TweakItem).
	const selectionByKey = useRef<Map<string, string | null>>(new Map());
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const { addItem, clear, setPhase, phase } = session;

	const stop = useCallback(() => {
		if (pollRef.current) clearInterval(pollRef.current);
		pollRef.current = null;
	}, []);
	useEffect(() => () => stop(), [stop]);

	// Reset the draft whenever a new target is chosen.
	useEffect(() => {
		setDraft("");
	}, [target?.blockRef]);

	const resetRun = useCallback(() => {
		stop();
		setRunItems([]);
		setMessage("");
		clear();
		setPhase("targeting");
	}, [stop, clear, setPhase]);

	const handleAdd = useCallback(() => {
		if (!target || draft.trim().length === 0) return;
		selectionByKey.current.set(target.blockRef, target.selectionText);
		addItem({
			targetKey: target.blockRef,
			displaySnippet: target.markdown.slice(0, 48).replace(/\s+/g, " ").trim() || target.blockRef,
			instruction: draft.trim(),
		});
		setDraft("");
		onClose();
	}, [target, draft, addItem, onClose]);

	const handleCancel = useCallback(() => {
		setDraft("");
		onClose();
	}, [onClose]);

	function buildPrompt(): string {
		const lines = [
			`Edit the file \`${path}\` (a Markdown document). Apply these changes:`,
			"",
		];
		session.items.forEach((q, i) => {
			lines.push(`${i + 1}. \`${q.displaySnippet}\`: ${q.instruction}`);
		});
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

	// Mirror runItems into a ref so the poll loop reads fresh state.
	const runItemsRef = useRef<RunItem[]>([]);
	runItemsRef.current = runItems;

	const startPolling = useCallback(() => {
		stop();
		const started = Date.now();
		pollRef.current = setInterval(async () => {
			if (Date.now() - started > 90000) {
				stop();
				setMessage("No response from agent yet.");
				setPhase("message");
				return;
			}
			let pending = false;
			let stateChanged = false;
			const snapshot = runItemsRef.current;
			// State updates land after this poll, so track terminal/ready responses
			// locally before deciding which panel can render.
			let hasReady = snapshot.some((item) => item.status === "ready");
			let hasTerminalWithoutPreview = snapshot.some(
				(item) => item.status === "invalidated",
			);
			for (const item of snapshot) {
				if (item.status !== "pending") continue;
				try {
					const res = await wsFetch(
						`/api/wiki/live/md-status?previewId=${encodeURIComponent(item.previewId)}`,
					);
					if (!res.ok) {
						pending = true;
						continue;
					}
					const data = (await res.json()) as {
						state: string;
						variants?: Variant[];
						selectedVariantId?: string | null;
					};
					if (data.state === "ready" && data.variants?.length) {
						stateChanged = true;
						hasReady = true;
						const selectedIdx = Math.max(
							0,
							data.variants.findIndex((v) => v.variantId === data.selectedVariantId),
						);
						setRunItems((prev) =>
							prev.map((p) =>
								p.itemId === item.itemId
									? { ...p, status: "ready", variants: data.variants ?? [], selectedIdx }
									: p,
							),
						);
					} else if (
						data.state === "invalidated" ||
						data.state === "accepted" ||
						data.state === "discarded"
					) {
						stateChanged = true;
						hasTerminalWithoutPreview = true;
						setRunItems((prev) =>
							prev.map((p) =>
								p.itemId === item.itemId ? { ...p, status: "invalidated" } : p,
							),
						);
					} else {
						pending = true;
					}
				} catch {
					pending = true;
				}
			}
			if (!hasReady && hasTerminalWithoutPreview) {
				stop();
				setMessage("file changed — retry");
				setPhase("message");
			} else if (!pending) {
				stop();
				setPhase("preview");
			} else if (stateChanged && hasReady) {
				setPhase("preview");
			}
		}, 1000);
	}, [stop, setPhase]);

	const onDispatch = useCallback(async () => {
		if (!attached || session.items.length === 0) return;
		await session.refreshPresence();
		setPhase("dispatching");
		setMessage("");
		try {
			const res = await wsFetch("/api/wiki/live/request", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path,
					kind: "generate",
					items: session.items.map((i) => ({
						instructionId: i.itemId,
						blockRef: i.targetKey,
						baseRevision,
						instruction: i.instruction,
						selectionText: selectionByKey.current.get(i.targetKey) ?? undefined,
					})),
				}),
			});
			if (!res.ok) throw new Error("Request failed.");
			const body = (await res.json()) as {
				items?: { instructionId: string; previewId: string | null }[];
			};
			const handles = body.items ?? [];
			const next: RunItem[] = [];
			for (const it of session.items) {
				const h = handles.find((x) => x.instructionId === it.itemId);
				if (!h || !h.previewId) continue;
				next.push({
					itemId: it.itemId,
					blockRef: it.targetKey,
					previewId: h.previewId,
					variants: [],
					selectedIdx: 0,
					status: "pending",
				});
			}
			if (next.length === 0) throw new Error("Request failed.");
			setRunItems(next);
			setPhase("waiting");
			startPolling();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Request failed.");
			setPhase("message");
		}
	}, [attached, session, path, baseRevision, setPhase, startPolling]);

	const cycleVariant = useCallback((itemId: string, dir: 1 | -1) => {
		setRunItems((prev) =>
			prev.map((p) =>
				p.itemId === itemId && p.variants.length > 0
					? {
							...p,
							selectedIdx:
								(p.selectedIdx + dir + p.variants.length) % p.variants.length,
						}
					: p,
			),
		);
	}, []);

	const resolveItem = useCallback(
		async (item: RunItem, action: "accept" | "discard") => {
			setPhase("resolving");
			try {
				const res = await wsFetch("/api/wiki/live/md-resolve", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						previewId: item.previewId,
						action,
						...(action === "accept"
							? { variantId: item.variants[item.selectedIdx]?.variantId }
							: {}),
					}),
				});
				if (!res.ok) {
					if (res.status === 409) setMessage("file changed — retry");
					else setMessage("Could not resolve proposal.");
					setPhase("message");
					return;
				}
				if (action === "accept") await useProofStore.getState().loadSnapshot(path);
			} catch {
				setMessage("Could not resolve proposal.");
				setPhase("message");
				return;
			}
			// Mark resolved and finalize when the whole run is done.
			setRunItems((prev) => {
				const updated = prev.map((p) =>
					p.itemId === item.itemId ? { ...p, status: "resolved" as const } : p,
				);
				const remaining = updated.some(
					(p) => p.status === "ready" || p.status === "pending",
				);
				if (!remaining) {
					queueMicrotask(() => resetRun());
					queueMicrotask(() => onClose());
				} else {
					setPhase("preview");
				}
				return updated;
			});
		},
		[path, setPhase, resetRun, onClose],
	);

	// The item currently under review (first ready one).
	const current = runItems.find((p) => p.status === "ready") ?? null;

	// Hide the block being previewed so the ephemeral preview stands in for it.
	useEffect(() => {
		if (!current) return;
		const el = scrollRef.current?.querySelector(
			`[data-block-ref="${CSS.escape(current.blockRef)}"]`,
		) as HTMLElement | null;
		if (!el) return;
		el.style.visibility = "hidden";
		return () => {
			el.style.visibility = "";
		};
	}, [current, scrollRef]);

	const runInFlight =
		phase === "dispatching" ||
		phase === "waiting" ||
		phase === "preview" ||
		phase === "resolving";

	const dispatchDisabled = !attached || session.items.length === 0;

	return {
		contentKind: "markdown",
		dispatchLabel: TWEAK_DISPATCH_LABELS.markdown,
		countBarNoun: "tweak",
		items: session.items,
		removeItem: session.removeItem,
		clear: () => {
			session.clear();
			onClose();
		},
		showQueueBar: !runInFlight && phase !== "message",
		onDispatch: () => void onDispatch(),
		dispatchDisabled,
		renderTargeting: () => {
			if (runInFlight || phase === "message" || !target) return null;
			const pos = positions.get(target.blockRef);
			if (!pos) return null;
			const availableWidth =
				scrollRef.current?.clientWidth ||
				(typeof window === "undefined" ? 1024 : window.innerWidth);
			const panelWidth = Math.min(384, Math.max(0, availableWidth - 16));
			const panelLeft = Math.min(
				Math.max(8, pos.left),
				Math.max(8, availableWidth - panelWidth - 8),
			);
			return (
				<>
					{draft.trim().length === 0 && (
						<div
							aria-hidden="true"
							className="fixed inset-0 z-30"
							onPointerDown={handleCancel}
						/>
					)}
					<MarkdownTargeting
						pos={pos}
						panelLeft={panelLeft}
						panelWidth={panelWidth}
						draft={draft}
						onChange={setDraft}
						onAdd={handleAdd}
						onCancel={handleCancel}
					/>
				</>
			);
		},
		renderRunPanel: () => {
			if (phase === "message") {
				const pos = target ? positions.get(target.blockRef) : undefined;
				return (
					<MarkdownMessage
						message={message}
						pos={pos}
						onDismiss={resetRun}
						onCopyPrompt={session.items.length > 0 ? () => void handleCopyPrompt() : undefined}
						copied={copied}
						promptModal={promptModal}
						onDismissPrompt={() => setPromptModal(null)}
					/>
				);
			}
			if ((phase === "waiting" || phase === "dispatching") && runItems.length > 0) {
				return <MarkdownWaiting />;
			}
			if ((phase === "preview" || phase === "resolving") && current) {
				const pos = positions.get(current.blockRef);
				if (!pos) return null;
				const resolvedCount = runItems.filter((p) => p.status === "resolved").length;
				return (
					<MarkdownPreview
						pos={pos}
						item={current}
						path={path}
						isViewing={isViewing}
						index={resolvedCount + 1}
						total={runItems.length}
						busy={phase === "resolving"}
						onCycle={(dir) => cycleVariant(current.itemId, dir)}
						onAccept={() => void resolveItem(current, "accept")}
						onDiscard={() => void resolveItem(current, "discard")}
					/>
				);
			}
			return null;
		},
		renderQueueBarExtras: () => (
			<>
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
				{promptModal !== null && (
					<MarkdownPromptModal text={promptModal} onDone={() => setPromptModal(null)} />
				)}
			</>
		),
	};
}

function MarkdownTargeting({
	pos,
	panelLeft,
	panelWidth,
	draft,
	onChange,
	onAdd,
	onCancel,
}: {
	pos: BlockPos;
	panelLeft: number;
	panelWidth: number;
	draft: string;
	onChange: (v: string) => void;
	onAdd: () => void;
	onCancel: () => void;
}) {
	return (
		<div
			className="absolute z-40 box-border max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl"
			style={{
				top: pos.top,
				left: panelLeft,
				width: panelWidth,
				maxHeight: "calc(100vh - 1rem)",
				overflowY: "auto",
			}}
		>
			<div className="mb-2 flex items-center justify-between">
				<span className="font-medium">Target</span>
			</div>
			<textarea
				autoFocus
				value={draft}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onAdd();
				}}
				rows={3}
				placeholder="What should change?"
				className="max-h-[40vh] w-full resize-y overflow-y-auto rounded border border-border bg-background px-2 py-1.5"
			/>
			<div className="mt-2 flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="rounded border border-border px-3 py-1 hover:bg-accent"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={draft.trim().length === 0}
					onClick={onAdd}
					className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
				>
					Add tweak
				</button>
			</div>
		</div>
	);
}

function MarkdownWaiting() {
	return (
		<div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-[12px] shadow-xl">
			<div className="animate-pulse text-muted-foreground">Generating…</div>
		</div>
	);
}

function MarkdownPromptModal({ text, onDone }: { text: string; onDone: () => void }) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
			<div className="w-[min(34rem,calc(100vw-2rem))] space-y-2 rounded-lg border border-border bg-popover p-4 text-[12px] shadow-xl">
				<div className="font-medium text-foreground">Prompt</div>
				<p className="text-[11px] text-muted-foreground/70">
					Copy this and run it in your agent. (Clipboard access needs an https connection, so
					copy manually here.)
				</p>
				<textarea
					readOnly
					value={text}
					rows={8}
					ref={(el) => el?.select()}
					className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				/>
				<div className="flex items-center justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={onDone}
						className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}

function MarkdownMessage({
	message,
	pos,
	onDismiss,
	onCopyPrompt,
	copied,
	promptModal,
	onDismissPrompt,
}: {
	message: string;
	pos: BlockPos | undefined;
	onDismiss: () => void;
	onCopyPrompt?: () => void;
	copied: boolean;
	promptModal: string | null;
	onDismissPrompt: () => void;
}) {
	return (
		<div
			className="absolute z-40 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl"
			style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { top: 12, left: 12 }}
		>
			<p className="text-amber-600">{message}</p>
			<div className="mt-2 flex items-center justify-end gap-2">
				{onCopyPrompt && (
					<button
						type="button"
						onClick={onCopyPrompt}
						className="rounded border border-border px-2 py-1"
					>
						{copied ? "Copied" : "Copy as prompt"}
					</button>
				)}
				<button
					type="button"
					onClick={onDismiss}
					className="rounded border border-border px-2 py-1"
				>
					Dismiss
				</button>
			</div>
			{promptModal !== null && (
				<MarkdownPromptModal text={promptModal} onDone={onDismissPrompt} />
			)}
		</div>
	);
}

function MarkdownPreview({
	pos,
	item,
	path,
	isViewing,
	index,
	total,
	busy,
	onCycle,
	onAccept,
	onDiscard,
}: {
	pos: BlockPos;
	item: RunItem;
	path: string;
	isViewing: boolean;
	index: number;
	total: number;
	busy: boolean;
	onCycle: (dir: 1 | -1) => void;
	onAccept: () => void;
	onDiscard: () => void;
}) {
	const [html, setHtml] = useState("");
	const candidate = item.variants[item.selectedIdx]?.markdown;
	useEffect(() => {
		if (!candidate) return;
		let gone = false;
		void markdownToHtml(candidate, { pagePath: path, sanitize: isViewing }).then((value) => {
			if (!gone) setHtml(value);
		});
		return () => {
			gone = true;
		};
	}, [candidate, path, isViewing]);
	return (
		<div
			className="absolute z-40 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl"
			style={{ top: pos.top, left: pos.left, width: pos.width }}
		>
			<div className="mb-2 flex items-center justify-between">
				<span className="font-medium">
					Proposal {index}/{total}
				</span>
				<span className="text-muted-foreground">
					Variant {item.selectedIdx + 1}/{item.variants.length}
				</span>
			</div>
			<div
				className="max-h-64 overflow-auto rounded border border-border p-2"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			<div className="mt-2 flex items-center justify-between">
				<button type="button" onClick={() => onCycle(-1)}>
					‹
				</button>
				<button type="button" onClick={() => onCycle(1)}>
					›
				</button>
				<div className="flex gap-2">
					<button
						type="button"
						disabled={busy}
						onClick={onDiscard}
						className="rounded border border-border px-2 py-1 disabled:opacity-50"
					>
						Discard
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={onAccept}
						className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
					>
						Accept
					</button>
				</div>
			</div>
		</div>
	);
}
