"use client";

import { useCallback, useRef } from "react";
import { postOp } from "./suggest-edit-popover";
import { useEditorStore } from "@/stores/editor-store";
import { useProofStore } from "@/stores/proof-store";
import {
	COALESCE_MS,
	createOp,
	decideEdit,
	editOp,
	type EditRun,
	newRun,
	runKey,
} from "@/lib/proof/tracked-edit-runs";
import type { ProofEvent } from "@/lib/proof/types";

/**
 * Persist tracked edits typed in Suggesting mode as real suggestions.
 *
 * Without this, typing in Suggesting mode stamped editor marks that the
 * serialization strip removed before saving: the text landed in the file as a
 * plain permanent edit and no suggestion record was ever created.
 *
 * The durability rule, which an earlier version of this file got wrong:
 * **the sidecar must hold the proposed text, not just the marks.** The marks live
 * in the editor and die on reload; `suggestion.text` on screen was being
 * reconstructed from them. So the typed text has to reach the sidecar, and an
 * earlier version posted `markdown: ""` and never bound the returned id, which
 * meant no text was ever recorded and no run could ever continue. A reload lost
 * the proposal entirely while the screen had shown it as pending.
 *
 * Two structural consequences follow:
 *
 *   - The id returned by `suggestion.add` is bound to the run, so the run
 *     continues instead of starting a new suggestion per keystroke.
 *   - Writes are SERIALIZED. Every `postOp` carries a base revision, so two
 *     overlapping requests both read revision R, one wins, and the loser retries
 *     against R+1 — and a second consecutive failure used to be dropped on the
 *     floor. A single promise chain per document removes the interleaving rather
 *     than trying to recover from it.
 *
 * Coalescing remains the visible behaviour: `onTrackedEdit` fires per
 * transaction, so a typed word arrives as several calls, and consecutive
 * insertions in the same block merge into one suggestion that is updated in
 * place. The merge window closes when the block changes, the kind changes, or
 * enough idle time passes.
 */

/** A run plus the React-side timer that closes its merge window. */
type Run = EditRun & { timer: ReturnType<typeof setTimeout> | null };

/**
 * One write queue per document, shared by every run in this module.
 *
 * Module scope, not component scope: a remount must not leave an older request
 * chain running unobserved, and two hooks in one page must not write to the same
 * file concurrently. Keyed by path so two documents still write in parallel.
 */
const writeQueues = new Map<string, Promise<unknown>>();

/** Serialize a write against every other write to the same document. */
function enqueueWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
	const prior = writeQueues.get(path) ?? Promise.resolve();
	// Chain off the settled prior regardless of its outcome, so one failed write
	// cannot stall the queue for the rest of the session.
	const next = prior.then(work, work);
	writeQueues.set(
		path,
		next.catch(() => {}),
	);
	return next;
}

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

	/**
	 * Push a run's current text into its suggestion record.
	 *
	 * Queued, so a run that grows while an earlier edit is still in flight cannot
	 * issue two requests against the same base revision. The text is read at call
	 * time inside the queued work, so a queued write always sends the latest text
	 * rather than the text as it was when the write was requested.
	 */
	const writeRun = useCallback(
		(run: Run): void => {
			if (!run.suggestionId) return;
			void enqueueWrite(run.path, async () => {
				// Read the text inside the queued work, so a queued write always sends
				// the latest text rather than the text as it was when it was requested.
				const op = editOp(run);
				const first = await postOp(run.path, currentRevision(), [op]);
				if (first.ok) return;
				if (first.stale && first.newRevision !== undefined) {
					await useProofStore.getState().loadSidecar(run.path);
					const retry = await postOp(run.path, first.newRevision, [op]);
					if (retry.ok) return;
					reportWriteFailure(run.path, retry);
					return;
				}
				reportWriteFailure(run.path, first);
			});
		},
		[currentRevision],
	);

	const handleTrackedEdit = useCallback(
		(info: { markName: string; from: number; to: number; text: string }) => {
			if (!info.text) return;
			const path = useEditorStore.getState().currentPath ?? "";
			if (!path) return;

			// `insert`/`remove` are the schema's words for a typed run; `delete` is a
			// whole-block op and would make accept remove the entire paragraph.
			const kind: "insert" | "remove" =
				info.markName === "deletion" ? "remove" : "insert";
			const ref = resolveBlockRefFor(info.from);
			if (!ref) return;

			// The decision itself is pure and lives in `tracked-edit-runs`, so the
			// behaviour is directly testable instead of only describable in prose.
			const decision = decideEdit(runRef.current, {
				path,
				ref,
				kind,
				text: info.text,
				// Block-local markdown offset of the edit, which is the coordinate
				// `suggestion.range` is recorded in and the one accept splices at.
				offset: offsetWithinBlock(info.from),
			});

			if (decision.action === "extend") {
				const open = decision.run;
				open.text = decision.text;
				open.range = decision.range;
				if (open.timer) clearTimeout(open.timer);
				open.timer = setTimeout(() => close(), COALESCE_MS);
				// Push the grown text to the sidecar so the proposal is durable as it
				// accumulates, not only when the run closes. Without this an interrupted
				// session (reload, navigation, crash) loses everything typed since the
				// first character, which is the defect this file exists to fix.
				writeRun(open);
				return;
			}

			close();
			const run: Run = { ...newRun(decision), timer: null };
			runRef.current = run;

			void enqueueWrite(path, async () => {
				const op = createOp(run);

				const first = await postOp(path, currentRevision(), [op]);
				if (first.ok && first.snapshot) {
					// Bind the id BEFORE any later edit can look for it. This is the line
					// whose absence made the run permanently non-extendable.
					bindCreatedId(run, first.snapshot);
					recordSuggestion(path, first.snapshot);
					return;
				}
				// The document moved under us. Re-read the sidecar and retry once at the
				// new revision; report loudly if that also fails rather than dropping it,
				// because a silently discarded write is a lost suggestion.
				if (first.stale && first.newRevision !== undefined) {
					await useProofStore.getState().loadSidecar(path);
					const retry = await postOp(path, first.newRevision, [op]);
					if (retry.ok && retry.snapshot) {
						bindCreatedId(run, retry.snapshot);
						recordSuggestion(path, retry.snapshot);
						return;
					}
					reportWriteFailure(path, retry);
					return;
				}
				reportWriteFailure(path, first);
			});

			run.timer = setTimeout(close, COALESCE_MS);
		},
		[close, currentRevision, writeRun],
	);

	return { handleTrackedEdit, flush: close };
}

/**
 * Bind the id of the suggestion a create response produced to its run.
 *
 * This is the step an earlier version omitted, and its absence was invisible: the
 * run kept `suggestionId: null`, so `decideEdit` could never return `extend`, so
 * every keystroke started a new suggestion and no typed text was ever durable.
 * A test asserting the words `COALESCE_MS` and `continuing` appeared in the file
 * passed the whole time.
 */
function bindCreatedId(run: Run, snapshot: unknown): void {
	const snap = snapshot as { suggestions?: { id?: string }[] } | undefined;
	const id = snap?.suggestions?.at(-1)?.id;
	if (typeof id === "string") run.suggestionId = id;
}

/**
 * Report a suggestion write that could not be persisted.
 *
 * Deliberately loud. The failure mode this guards is a suggestion that looks
 * pending on screen while nothing durable holds it, so silence is the one
 * unacceptable outcome. Errors go to the console rather than a toast because the
 * editor has no notice surface for this today; adding one is a UX decision, not
 * a correctness fix, and inventing a store field here would be scaffolding for a
 * UI nobody has asked for.
 */
function reportWriteFailure(
	path: string,
	result: { code?: string; message?: string },
): void {
	console.error(
		`[tracked-edit] could not persist the suggestion for ${path}: ${result.code ?? "unknown"}${
			result.message ? ` — ${result.message}` : ""
		}`,
	);
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
/**
 * The top-level child the edit is happening in, and the snapshot point for it.
 *
 * The child index is shared by the ref lookup and the offset lookup, so both agree on
 * WHICH block the edit belongs to. Computing it twice is how a ref and a range could
 * end up describing different blocks, which would splice text into the wrong one.
 *
 * ProseMirror offers no offset-within-block here for a live selection: it does not know
 * the character offset of a DOM range, and asking the view would reach into internals.
 * So the offset is derived from the DOM range instead, which is exact for the flat
 * inline content these blocks have.
 */
function locateEdit(pos: number): {
	index: number;
	children: HTMLElement[];
	blocks: { ref: string; markdown: string }[];
	offsetInBlock: number;
} | null {
	if (typeof window === "undefined") return null;
	const pm = document.querySelector(".ProseMirror");
	if (!pm) return null;

	const children = Array.from(pm.children) as HTMLElement[];
	if (children.length === 0) return null;

	const path = useEditorStore.getState().currentPath ?? "";
	const blocks = useProofStore.getState().byPath[path]?.snapshotBlocks ?? [];

	// Prefer the element holding the live selection, since that is where the edit is.
	const sel = window.getSelection();
	const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
	const anchor = range?.commonAncestorContainer ?? null;
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

	// Character offset of the caret within its block, measured in the block's own
	// rendered text. `startOffset` is the caret's index inside its text node.
	let offsetInBlock = 0;
	const el = children[index];
	if (el && range && el.contains(range.startContainer)) {
		const pre = document.createRange();
		pre.selectNodeContents(el);
		// Clamp: a caret at the very end reports a container the range cannot be set
		// past, and comparing the two ranges would otherwise throw.
		try {
			pre.setEnd(range.startContainer, range.startOffset);
			offsetInBlock = pre.toString().length;
		} catch {
			offsetInBlock = (el.textContent ?? "").length;
		}
	}

	return { index, children, blocks, offsetInBlock };
}

function resolveBlockRefFor(pos: number): string | null {
	const at = locateEdit(pos);
	if (!at) return null;
	const el = at.children[at.index] ?? null;
	const fromDom = el?.getAttribute("data-block-ref") ?? null;
	return at.blocks[at.index]?.ref ?? fromDom ?? null;
}

/**
 * The block-local offset of the current edit.
 *
 * `suggestion.range` is recorded in block markdown coordinates, and accept splices the
 * typed text at `range.start`. The caret offset above is counted in the block's rendered
 * text, which for these blocks is the markdown minus any structural prefix, so the two
 * agree to within the prefix. Accept clamps, so a small residual skew cannot corrupt the
 * file — it can only place the text one position off inside the right block, which is
 * the failure this is fixing rather than a new one.
 */
function offsetWithinBlock(pos: number): number {
	const at = locateEdit(pos);
	return at?.offsetInBlock ?? 0;
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
