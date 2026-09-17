"use client";

import { ClipboardCopy } from "lucide-react";
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
}

type CopiedTarget = number | "all" | null;
type DisplayItem = { snippet?: unknown; text?: unknown; proposed?: unknown; replies?: unknown; turns?: unknown; kind?: unknown };
const str = (value: unknown) => (typeof value === "string" ? value : "");
const replies = (item: DisplayItem) => typeof item.replies === "number" ? item.replies : Array.isArray(item.turns) ? Math.max(0, item.turns.length - 1) : 0;

function chipFor(kind: unknown) {
	if (kind === "suggestion") return { label: "Suggestion", className: "bg-success/10 text-success" };
	if (kind === "instruction") return { label: "Instruction", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" };
	return { label: "Comment", className: "bg-muted text-muted-foreground" };
}

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
		setClipboardAvailable(window.isSecureContext && typeof navigator.clipboard?.writeText === "function");
		return () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); };
	}, []);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
		window.addEventListener("keydown", onKey);
		const timer = window.setTimeout(() => window.addEventListener("mousedown", onDown), 10);
		return () => { window.clearTimeout(timer); window.removeEventListener("keydown", onKey); window.removeEventListener("mousedown", onDown); };
	}, [open]);
	if (items.length === 0) return null;
	function showCopied(target: CopiedTarget) {
		setCopiedTarget(target);
		if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopiedTarget(null), 1500);
	}
	async function copy(text: string, target: CopiedTarget) {
		if (!clipboardAvailable) { setShowText(true); return; }
		try { await navigator.clipboard.writeText(text); showCopied(target); } catch { setClipboardAvailable(false); setShowText(true); }
	}
	return <div className="relative" ref={rootRef}>
		<button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={open} title="Copy comments and suggestions as a prompt" className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [@media(pointer:coarse)]:min-h-11"><ClipboardCopy className="h-2.5 w-2.5" />Copy as prompt<span className="rounded-full bg-muted px-1 text-[9.5px] text-foreground">{items.length}</span></button>
		{open && <div role="dialog" aria-label="Copy as prompt" className="absolute bottom-full right-0 z-50 mb-2 w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-background p-0 shadow-lg">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5"><div className="flex min-w-0 items-center gap-2"><h2 className="text-[13px] font-medium text-foreground">Copy as prompt</h2><span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{items.length}</span></div><button type="button" onClick={() => void copy(prompt, "all")} className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{copiedTarget === "all" ? "Copied" : "Copy all"}</button></div>
			<ol className="max-h-72 overflow-y-auto py-1">{items.map((raw, index) => { const item = raw as DisplayItem; const chip = chipFor(item.kind); const count = replies(item); return <li key={`${String(item.kind)}-${index}`} className="group flex items-start gap-2 px-3 py-2 transition-colors hover:bg-accent/40"><div className="min-w-0 flex-1"><div className="mb-0.5 flex items-center gap-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${chip.className}`}>{chip.label}</span><span className="line-clamp-2 text-[12px] italic text-muted-foreground">“{str(item.snippet)}”</span></div><div className="text-[13px] text-foreground">{str(item.text) || str(item.proposed)}{count > 0 && <span className="ml-1.5 text-[11px] text-muted-foreground">+{count} {count === 1 ? "reply" : "replies"}</span>}</div></div><button type="button" aria-label={`Copy item ${index + 1} as prompt`} title="Copy item" onClick={() => void copy(buildPromptFromAnnotations(path, [raw]), index)} className="mt-0.5 shrink-0 rounded p-1 text-sm leading-none text-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11">{copiedTarget === index ? "✓" : "⎘"}</button></li>; })}</ol>
			{!clipboardAvailable && <div className="space-y-2 px-3 pb-2"><button type="button" onClick={() => setShowText((v) => !v)} className="rounded border border-border px-2 py-0.5 text-[11px] text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{showText ? "Hide text" : "Show text"}</button>{showText && <textarea readOnly value={prompt} aria-label="Prompt text" className="min-h-32 w-full resize-y rounded border border-border bg-background p-2 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}</div>}
			<div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">Paste into any agent — nothing is written to the file.</div>
		</div>}
	</div>;
}
