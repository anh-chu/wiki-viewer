"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { wsFetch } from "@/lib/workspace-client";
import { useProofStore } from "@/stores/proof-store";
import { LivePresence, useLiveAttached } from "./live-presence";

type Target = { blockRef: string; markdown: string; selectionText: string | null; selectionStart: number | null; selectionEnd: number | null };
type Variant = { variantId: string; label: string; markdown: string };
interface Props { path: string; target: Target | null; onClose: () => void; positions: Map<string, { top: number; left: number; width: number; bottom: number }>; scrollRef: RefObject<HTMLDivElement | null>; isViewing: boolean; baseRevision: number; }
type Phase = "targeted" | "waiting" | "generating" | "preview" | "resolving" | "message";

export function LiveOverlay({ path, target, onClose, positions, scrollRef, isViewing, baseRevision }: Props) {
	const attached = useLiveAttached();
	const [instruction, setInstruction] = useState("");
	const [phase, setPhase] = useState<Phase>("targeted");
	const [variants, setVariants] = useState<Variant[]>([]);
	const [selected, setSelected] = useState(0);
	const [html, setHtml] = useState("");
	const [message, setMessage] = useState("");
	const previewRef = useRef<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const pos = target ? positions.get(target.blockRef) : undefined;
	const stop = useCallback(() => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; }, []);
	useEffect(() => () => stop(), [stop]);
	useEffect(() => { setInstruction(""); setVariants([]); setSelected(0); setHtml(""); setPhase(target ? "targeted" : "message"); }, [target]);
	useEffect(() => {
		const candidate = variants[selected]?.markdown;
		if (!candidate) return;
		let gone = false;
		void markdownToHtml(candidate, { pagePath: path, sanitize: isViewing }).then((value) => { if (!gone) setHtml(value); });
		return () => { gone = true; };
	}, [variants, selected, path, isViewing]);
	useEffect(() => {
		if (!target || !variants.length) return;
		const el = scrollRef.current?.querySelector(`[data-block-ref="${CSS.escape(target.blockRef)}"]`) as HTMLElement | null;
		if (!el) return;
		el.style.visibility = "hidden";
		return () => { el.style.visibility = ""; };
	}, [target, variants.length, scrollRef]);
	const request = async () => {
		if (!target || !instruction.trim() || !attached) return;
		setPhase("generating");
		try {
			const res = await wsFetch("/api/wiki/live/md-request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, blockRef: target.blockRef, baseRevision, instruction: instruction.trim(), selectionText: target.selectionText ?? undefined, selectionStart: target.selectionStart ?? undefined, selectionEnd: target.selectionEnd ?? undefined }) });
			if (!res.ok) throw new Error("Request failed.");
			const body = await res.json() as { previewId: string };
			previewRef.current = body.previewId; setPhase("waiting");
			const started = Date.now();
			pollRef.current = setInterval(async () => {
				if (Date.now() - started > 90000) { stop(); setMessage("No response from agent yet."); setPhase("message"); return; }
				try { const status = await wsFetch(`/api/wiki/live/md-status?previewId=${encodeURIComponent(body.previewId)}`); if (!status.ok) return; const data = await status.json() as { state: string; variants?: Variant[]; selectedVariantId?: string | null };
					if (data.state === "ready" && data.variants?.length) { stop(); setVariants(data.variants); setSelected(Math.max(0, data.variants.findIndex((v) => v.variantId === data.selectedVariantId))); setPhase("preview"); }
					else if (data.state === "invalidated") { stop(); setMessage("file changed — retry"); setPhase("message"); }
				} catch {}
			}, 1000);
		} catch (error) { setMessage(error instanceof Error ? error.message : "Request failed."); setPhase("message"); }
	};
	const resolve = async (action: "accept" | "discard") => {
		if (!previewRef.current) { onClose(); return; }
		setPhase("resolving");
		const res = await wsFetch("/api/wiki/live/md-resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ previewId: previewRef.current, action, ...(action === "accept" ? { variantId: variants[selected]?.variantId } : {}) }) });
		if (res.ok) { if (action === "accept") await useProofStore.getState().loadSnapshot(path); onClose(); return; }
		if (res.status === 409) { setMessage("file changed — retry"); setPhase("message"); return; }
		setMessage("Could not resolve proposal."); setPhase("message");
	};
	if (!target || !pos) return null;
	const left = pos.left;
	return <>
		<div className="fixed right-4 top-3 z-50"><LivePresence /></div>
		<div className="absolute z-40 rounded-lg border border-border bg-popover p-3 text-[12px] shadow-xl" style={{ top: pos.top, left, width: pos.width }}>
			<div className="mb-2 flex items-center justify-between"><span className="font-medium">{phase === "preview" ? "Proposal" : "Target"}</span>{phase === "preview" && <span className="text-muted-foreground">Variant {selected + 1}/{variants.length}</span>}</div>
			{(phase === "targeted" || phase === "message") && <><textarea autoFocus value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} placeholder="What should change?" className="w-full resize-y rounded border border-border bg-background px-2 py-1.5" /><div className="mt-2 flex items-center justify-between"><LivePresence /><button type="button" disabled={!instruction.trim() || !attached} onClick={() => void request()} className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">Go</button></div></>}
			{(phase === "waiting" || phase === "generating") && <div className="animate-pulse text-muted-foreground">Generating…</div>}
			{phase === "preview" && <><div className="max-h-64 overflow-auto rounded border border-border p-2" dangerouslySetInnerHTML={{ __html: html }} /><div className="mt-2 flex items-center justify-between"><button type="button" onClick={() => setSelected((selected + variants.length - 1) % variants.length)}>‹</button><button type="button" onClick={() => setSelected((selected + 1) % variants.length)}>›</button><div className="flex gap-2"><button type="button" onClick={() => void resolve("discard")} className="rounded border border-border px-2 py-1">Discard</button><button type="button" onClick={() => void resolve("accept")} className="rounded bg-primary px-2 py-1 text-primary-foreground">Accept</button></div></div></>}
			{phase === "message" && <p className="mt-2 text-amber-600">{message}</p>}
		</div>
	</>;
}
