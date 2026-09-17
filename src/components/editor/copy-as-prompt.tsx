"use client";

import { ClipboardCopy } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import {
	buildPromptFromAnnotations,
	mapAnnotationsToPromptItems,
	type PromptComment,
	type SnippetResolver,
} from "@/lib/proof/prompt-serialize";
import type { Suggestion } from "@/lib/proof/types";

export interface CopyAsPromptProps {
	path: string;
	comments: readonly PromptComment[];
	suggestions: readonly Suggestion[];
	resolveSnippet?: SnippetResolver;
	suggestionCount?: number;
	onReviewSuggestions?: () => void;
}

type CopiedTarget = number | "all" | null;
type DisplayItem = { snippet?: unknown; blockText?: unknown; currentText?: unknown; text?: unknown; proposed?: unknown; replies?: unknown; turns?: unknown; kind?: unknown };
const str = (value: unknown) => (typeof value === "string" ? value : "");
const replies = (item: DisplayItem) => typeof item.replies === "number" ? item.replies : Array.isArray(item.turns) ? Math.max(0, item.turns.length - 1) : 0;

function chipFor(kind: unknown) {
	if (kind === "suggestion") return { label: "Suggestion", className: "bg-success/10 text-success" };
	if (kind === "instruction") return { label: "Instruction", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
	return { label: "Comment", className: "bg-muted text-muted-foreground" };
}

export function CopyAsPrompt({ path, comments, suggestions, resolveSnippet, suggestionCount = 0, onReviewSuggestions }: CopyAsPromptProps) {
	const items = mapAnnotationsToPromptItems(comments, suggestions, resolveSnippet);
	const prompt = buildPromptFromAnnotations(path, items);
	const [open, setOpen] = useState(false);
	const [clipboardAvailable, setClipboardAvailable] = useState(false);
	const [showText, setShowText] = useState(false);
	const [copiedTarget, setCopiedTarget] = useState<CopiedTarget>(null);
	const copiedTimer = useRef<number | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const [dialogPosition, setDialogPosition] = useState<{ top: number; right: number } | null>(null);

	useEffect(() => {
		setClipboardAvailable(window.isSecureContext && typeof navigator.clipboard?.writeText === "function");
		return () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); };
	}, []);
	useEffect(() => {
		if (!open) return;
		const anchorDialog = () => {
			const rect = triggerRef.current?.getBoundingClientRect();
			if (!rect) return;
			const width = Math.min(416, window.innerWidth - 32);
			setDialogPosition({
				top: Math.max(8, rect.top - 8),
				right: Math.max(8, Math.min(window.innerWidth - width - 8, window.innerWidth - rect.right)),
			});
		};
		anchorDialog();
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!rootRef.current?.contains(target) && !dialogRef.current?.contains(target)) setOpen(false);
		};
		window.addEventListener("resize", anchorDialog);
		window.addEventListener("keydown", onKey);
		const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 10);
		return () => { window.clearTimeout(timer); window.removeEventListener("resize", anchorDialog); window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
	}, [open]);
	if (items.length === 0 && suggestionCount <= 0) return null;
	function showCopied(target: CopiedTarget) {
		setCopiedTarget(target);
		if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopiedTarget(null), 1500);
	}
	async function copy(text: string, target: CopiedTarget) {
		if (!clipboardAvailable) { setShowText(true); return; }
		try { await navigator.clipboard.writeText(text); showCopied(target); } catch { setClipboardAvailable(false); setShowText(true); }
	}
	return <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2" ref={rootRef}>
		<div className="flex h-11 items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/95 px-4 py-2.5 shadow-lg backdrop-blur">
			<button ref={triggerRef} type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} title="Copy comments and suggestions as a prompt" className="inline-flex min-h-8 items-center gap-2 rounded-full text-[13px] font-medium text-zinc-100"><ClipboardCopy className="h-4 w-4 text-amber-400" />Copy as prompt<span className="rounded-full bg-zinc-700 px-1.5 text-[10px] leading-5 text-zinc-100">{items.length}</span></button>
			{suggestionCount > 0 && <><span aria-hidden="true" className="h-5 w-px bg-zinc-700" /><button type="button" onClick={onReviewSuggestions} className="rounded-full px-2.5 py-1 text-zinc-100 hover:bg-white/10">✎ {suggestionCount} suggestions</button></>}
		</div>
		{open && dialogPosition && createPortal(<div ref={dialogRef} role="dialog" aria-label="Copy as prompt" style={{ position: "fixed", top: dialogPosition.top, right: dialogPosition.right, width: "min(416px, calc(100vw - 2rem))", transform: "translateY(-100%)" }} className="z-[60] overflow-hidden rounded-xl border border-border bg-background p-0 shadow-lg">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5"><div className="flex min-w-0 items-center gap-2"><h2 className="text-[13px] font-medium text-foreground">Copy as prompt</h2><span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{items.length}</span></div><button type="button" onClick={() => void copy(prompt, "all")} className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{copiedTarget === "all" ? "Copied" : "Copy all"}</button></div>
			<ol className="max-h-72 overflow-y-auto py-1">{items.map((raw, index) => { const item = raw as DisplayItem; const chip = chipFor(item.kind); const count = replies(item); return <li key={`${String(item.kind)}-${index}`} className="group flex items-start gap-2 px-3 py-2 transition-colors hover:bg-accent/40"><div className="min-w-0 flex-1"><div className="mb-0.5 flex items-center gap-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${chip.className}`}>{chip.label}</span><span className="line-clamp-2 text-[12px] italic text-muted-foreground">“{str(item.blockText) || str(item.snippet)}”</span></div>{str(item.currentText) && <div className="line-clamp-2 text-[12px] italic text-muted-foreground">from “{str(item.currentText)}”</div>}<div className="text-[13px] text-foreground">{str(item.text) || str(item.proposed)}{count > 0 && <span className="ml-1.5 text-[11px] text-muted-foreground">+{count} {count === 1 ? "reply" : "replies"}</span>}</div></div><button type="button" aria-label={`Copy item ${index + 1} as prompt`} title="Copy item" onClick={() => void copy(buildPromptFromAnnotations(path, [raw]), index)} className="mt-0.5 shrink-0 rounded p-1 text-sm leading-none text-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">{copiedTarget === index ? "✓" : "⎘"}</button></li>; })}</ol>
			{!clipboardAvailable && <div className="space-y-2 px-3 pb-2"><button type="button" onClick={() => setShowText((v) => !v)} className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{showText ? "Hide text" : "Show text"}</button>{showText && <textarea readOnly value={prompt} aria-label="Prompt text" className="min-h-32 w-full resize-y rounded border border-border bg-background p-2 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}</div>}
			<div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Paste into any agent — nothing is written to the file.</div>
		</div>, document.body)}
	</div>;
}
