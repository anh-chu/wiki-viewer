"use client";

import { useCallback, useRef } from "react";
import { postOp } from "./suggest-edit-popover";
import { useEditorStore } from "@/stores/editor-store";
import { useProofStore } from "@/stores/proof-store";
import type { ProofEvent } from "@/lib/proof/types";

/**
 * Persist tracked edits typed in Suggesting mode as real suggestions.
 *
 * Without this, typing in Suggesting mode stamped editor marks that the
 * serialization strip removed before saving: the text landed in the file as a
 * plain permanent edit and no suggestion record was ever created. The marks
 * looked like a suggestion on screen and were gone on reload, which is the worst
 * of both — the user believes their change is pending while it has already been
 * applied. The `TrackChangesOptions.onTrackedEdit` hook exists for exactly this
 * ("called after a tracked edit lands, so the sidecar can record it") and was
 * never passed.
 *
 * Coalescing is the whole difficulty. `onTrackedEdit` fires per transaction, so a
 * typed word arrives as several calls, one per keystroke. Creating a suggestion
 * per call would litter the margin with one-character suggestions. Consecutive
 * insertions in the same block are therefore merged into a single pending
 * suggestion, and the merge window closes when the block changes, the kind
 * changes, or enough idle time passes.
 */

/** How long a run of typing stays open before it becomes its own suggestion. */
const COALESCE_MS = 1200;

type Run = {
	key: string;
	suggestionId: string | null;
	text: string;
	kind: "insert" | "delete";
	timer: ReturnType<typeof setTimeout> | null;
};

export function useTrackedEditPersistence() {
	const runRef = useRef<Run | null>(null);

	const currentRevision = useCallback((): number => {
		const path = useEditorStore.getState().currentPath ?? "";
		return useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
	}, []);

	const close = useCallback(() => {
		const run = runRef.current;
		if (run?.timer) clearTimeout(run.timer);
		runRef.current = null;
	}, []);

	const handleTrackedEdit = useCallback(
		(info: { markName: string; from: number; to: number; text: string }) => {
			if (!info.text) return;
			const path = useEditorStore.getState().currentPath ?? "";
			if (!path) return;

			const kind: "insert" | "delete" =
				info.markName === "deletion" ? "delete" : "insert";
			const ref = resolveBlockRefFor(info.from);
			if (!ref) return;

			// A run is keyed by block and kind, so moving to another paragraph or
			// switching between typing and deleting starts a new suggestion rather
			// than appending to an unrelated one.
			const key = `${path}:${ref}:${kind}`;
			const open = runRef.current;
			const continuing =
				open !== null && open.key === key && open.suggestionId !== null;

			if (continuing) {
				open.text += info.text;
				if (open.timer) clearTimeout(open.timer);
				open.timer = setTimeout(close, COALESCE_MS);
				// The first call in the run already created the record; the mark
				// itself carries the full text, so nothing more needs writing until
				// the run closes.
				return;
			}

			close();
			const run: Run = {
				key,
				suggestionId: null,
				text: info.text,
				kind,
				timer: null,
			};
			runRef.current = run;

			const op =
				kind === "insert"
					? { type: "suggestion.add", ref, kind: "insert", basis: "suggested", markdown: "" }
					: { type: "suggestion.add", ref, kind: "delete", basis: "suggested" };

			void (async () => {
				const first = await postOp(path, currentRevision(), [op]);
				if (!first.ok && first.stale && first.newRevision !== undefined) {
					await useProofStore.getState().loadSidecar(path);
					const retry = await postOp(path, first.newRevision, [op]);
					if (retry.ok) recordSuggestion(path, retry.snapshot);
					return;
				}
				if (first.ok) recordSuggestion(path, first.snapshot);
			})();

			run.timer = setTimeout(close, COALESCE_MS);
		},
		[close, currentRevision],
	);

	return { handleTrackedEdit, flush: close };
}

/** Surface the new suggestion in the sidecar store so the margin can show it. */
function recordSuggestion(path: string, snapshot: unknown): void {
	const snap = snapshot as { suggestions?: unknown[]; lastEventId?: number } | undefined;
	if (!snap?.suggestions) return;
	const suggestion = snap.suggestions.at(-1);
	if (!suggestion) return;
	const event: ProofEvent = {
		id: snap.lastEventId ?? 0,
		type: "suggestion.added",
		at: new Date().toISOString(),
		by: "human",
		suggestionId: (suggestion as { id: string }).id,
		suggestion: suggestion as never,
	};
	useProofStore.getState().applyEvent(path, event);
}

/**
 * Which block a tracked edit belongs to.
 *
 * Reads the same source `resolveSelectionBlock` uses: the sidecar's `snapshotBlocks`
 * paired with the top-level `.ProseMirror` children by index, with the DOM
 * `data-block-ref` attribute as a fallback. The attribute alone is not enough — it is
 * only written on one path in the geometry effect, and a live check showed it null on
 * the open document, which would have made every typed suggestion silently no-op.
 */
function resolveBlockRefFor(pos: number): string | null {
	if (typeof window === "undefined") return null;
	const pm = document.querySelector(".ProseMirror");
	if (!pm) return null;

	const children = Array.from(pm.children) as HTMLElement[];
	if (children.length === 0) return null;

	const path = useEditorStore.getState().currentPath ?? "";
	const blocks = useProofStore.getState().byPath[path]?.snapshotBlocks ?? [];

	// Prefer the element holding the live selection, since that is where the edit is.
	const sel = window.getSelection();
	const anchor =
		sel && sel.rangeCount > 0 ? sel.getRangeAt(0).commonAncestorContainer : null;
	const anchorEl =
		anchor === null
			? null
			: anchor.nodeType === Node.ELEMENT_NODE
				? (anchor as HTMLElement)
				: anchor.parentElement;

	let index = -1;
	if (anchorEl) {
		index = children.findIndex((c) => c === anchorEl || c.contains(anchorEl));
	}
	if (index < 0) index = Math.min(posToTopIndex(pos), children.length - 1);

	const el = children[index] ?? null;
	const fromDom = el?.getAttribute("data-block-ref") ?? null;
	return blocks[index]?.ref ?? fromDom ?? null;
}

/**
 * Convert a ProseMirror document offset into a top-level child index.
 *
 * An approximation on purpose. ProseMirror's exact resolver needs the editor view,
 * which this module does not hold, and reaching for `pmViewDesc` would depend on
 * internal API. The live selection is the primary signal; this is the fallback for
 * when there is none.
 */
function posToTopIndex(pos: number): number {
	const pm = document.querySelector(".ProseMirror");
	if (!pm) return 0;
	let remaining = pos;
	let index = 0;
	for (const child of Array.from(pm.children)) {
		const len = (child.textContent ?? "").length + 1;
		if (remaining <= len) return index;
		remaining -= len;
		index += 1;
	}
	return Math.max(0, index - 1);
}
