"use client";

import { ClipboardCopy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	buildPromptFromAnnotations,
	formatPromptItem,
	mapAnnotationsToPromptItems,
	type PromptComment,
	type SnippetResolver,
} from "@/lib/proof/prompt-serialize";
import type { Suggestion } from "@/lib/proof/types";

export interface CopyAsPromptProps {
	path: string;
	comments: readonly PromptComment[];
	suggestions: readonly Suggestion[];
	/** Resolve a readable snippet (block leading text) for an annotation ref. */
	resolveSnippet?: SnippetResolver;
}

type CopiedTarget = number | "all" | null;

/**
 * Read-only prompt surface for persisted comments and pending suggestions.
 * Renders a compact trigger that opens a popover; nothing when there is
 * nothing to copy (empty = zero chrome).
 */
export function CopyAsPrompt({ path, comments, suggestions, resolveSnippet }: CopyAsPromptProps) {
	const items = mapAnnotationsToPromptItems(comments, suggestions, resolveSnippet);
	const prompt = buildPromptFromAnnotations(path, items);
	const [open, setOpen] = useState(false);
	const [clipboardAvailable, setClipboardAvailable] = useState(false);
	const [showText, setShowText] = useState(false);
	const [copiedTarget, setCopiedTarget] = useState<CopiedTarget>(null);
	const copiedTimer = useRef<number | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setClipboardAvailable(
			window.isSecureContext && typeof navigator.clipboard?.writeText === "function",
		);
		return () => {
			if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		const onDown = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		const t = window.setTimeout(() => window.addEventListener("mousedown", onDown), 10);
		return () => {
			window.clearTimeout(t);
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("mousedown", onDown);
		};
	}, [open]);

	if (items.length === 0) return null;

	function showCopied(target: CopiedTarget) {
		setCopiedTarget(target);
		if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopiedTarget(null), 1500);
	}

	async function copy(text: string, target: CopiedTarget) {
		if (!clipboardAvailable) {
			setShowText(true);
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			showCopied(target);
		} catch {
			setClipboardAvailable(false);
			setShowText(true);
		}
	}

	return (
		<div className="relative" ref={rootRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Copy comments and suggestions as a prompt"
				className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11"
			>
				<ClipboardCopy className="h-2.5 w-2.5" />
				Copy as prompt
				<span className="rounded-full bg-muted px-1 text-[9.5px] text-foreground">{items.length}</span>
			</button>

			{open && (
				<div
					role="dialog"
					aria-label="Copy as prompt"
					className="absolute bottom-full right-0 z-50 mb-1 w-[min(24rem,calc(100vw-1rem))] space-y-2 rounded-md border border-border bg-popover p-3 shadow-golden-pop"
				>
					<div className="flex items-center justify-between gap-2">
						<h2 className="text-xs font-medium text-foreground">Copy as prompt</h2>
						<button
							type="button"
							onClick={() => void copy(prompt, "all")}
							className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{copiedTarget === "all" ? "Copied" : "Copy all"}
						</button>
					</div>

					<ol className="max-h-64 space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
						{items.map((item, index) => (
							<li key={`${item.kind}-${index}`} className="flex items-start gap-2">
								<span className="min-w-0 flex-1 whitespace-pre-wrap">
									{index + 1}. {formatPromptItem(item)}
								</span>
								<button
									type="button"
									aria-label={`Copy item ${index + 1} as prompt`}
									title="Copy item"
									onClick={() => void copy(buildPromptFromAnnotations(path, [item]), index)}
									className="shrink-0 rounded px-1 text-sm leading-none text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
								>
									{copiedTarget === index ? "✓" : "⎘"}
								</button>
							</li>
						))}
					</ol>

					{!clipboardAvailable && (
						<div className="space-y-2">
							<button
								type="button"
								onClick={() => setShowText((v) => !v)}
								className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{showText ? "Hide text" : "Show text"}
							</button>
							{showText && (
								<textarea
									readOnly
									value={prompt}
									aria-label="Prompt text"
									className="min-h-32 w-full resize-y rounded border border-border bg-background p-2 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								/>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
