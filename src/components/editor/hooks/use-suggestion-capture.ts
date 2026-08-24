"use client";

import { useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { captureSuggestion } from "@/lib/proof/suggest-capture";
import { useProofStore } from "@/stores/proof-store";
import { useEditorStore } from "@/stores/editor-store";
import { showError } from "@/lib/toast";

export interface SuggestionCaptureBlock {
	ref: string;
	markdown: string;
}

export interface SuggestionCaptureDecision {
	ref: string;
	kind: "replace" | "delete" | "insertAfter";
	markdown?: string;
}

export interface SuggestionCaptureBatchResult {
	captured: SuggestionCaptureDecision[];
	failed: SuggestionCaptureDecision[];
	shouldRevert: boolean;
}

/** Purely decide which block operations represent the current editor content. */
export function decideSuggestionCaptures(
	currentBlocks: readonly (string | null)[],
	snapshotBlocks: readonly SuggestionCaptureBlock[],
): SuggestionCaptureDecision[] {
	const decisions: SuggestionCaptureDecision[] = [];
	const count = Math.max(currentBlocks.length, snapshotBlocks.length);
	for (let i = 0; i < count; i++) {
		const curMd = currentBlocks[i];
		const snap = snapshotBlocks[i];
		if (snap && curMd !== null && curMd !== undefined) {
			if (normalizeMd(curMd) !== normalizeMd(snap.markdown)) {
				decisions.push({ ref: snap.ref, kind: "replace", markdown: curMd });
			}
		} else if (snap && curMd === null) {
			decisions.push({ ref: snap.ref, kind: "delete" });
		} else if (!snap && curMd !== null && curMd !== undefined && curMd.length > 0) {
			const lastRef = snapshotBlocks[snapshotBlocks.length - 1]?.ref;
			if (lastRef) decisions.push({ ref: lastRef, kind: "insertAfter", markdown: curMd });
		}
	}
	return decisions;
}

type CaptureSuggestion = typeof captureSuggestion;

/** Post each decided operation, retaining failed operations for retry. */
export async function captureSuggestionBatch(args: {
	path: string;
	decisions: readonly SuggestionCaptureDecision[];
	getRevision: () => number;
	refresh: () => Promise<void>;
	capture?: CaptureSuggestion;
}): Promise<SuggestionCaptureBatchResult> {
	const captured: SuggestionCaptureDecision[] = [];
	const failed: SuggestionCaptureDecision[] = [];
	const capture = args.capture ?? captureSuggestion;
	for (const decision of args.decisions) {
		try {
			const ok = await capture({
				path: args.path,
				...decision,
				getRevision: args.getRevision,
				refresh: args.refresh,
			});
			(ok ? captured : failed).push(decision);
		} catch {
			failed.push(decision);
		}
	}
	return { captured, failed, shouldRevert: captured.length > 0 && failed.length === 0 };
}

interface UseSuggestionCaptureOptions {
	/** Workspace-scoped root-relative path of the document being edited. */
	path: string | null;
	/** Live TipTap editor instance. */
	editorRef: React.MutableRefObject<Editor | null>;
	/** Scroll container used to locate `.ProseMirror`. */
	scrollContainerRef: React.MutableRefObject<HTMLElement | null>;
	/** Set true while applying snapshot content to suppress onUpdate. */
	isLoadingRef: React.MutableRefObject<boolean>;
	/** Ref to whether the editor is in viewing mode. */
	isViewingRef: React.MutableRefObject<boolean>;
	/** Master switch; disables capture when false. */
	enabled?: boolean;
}

interface SuggestionCaptureControls {
	/** Mark the current suggesting session dirty so the next flush emits ops. */
	markDirty: () => void;
	/** Flush pending block edits as human suggestions and resolve to snapshot on success. */
	flush: () => Promise<void>;
	/**
	 * Track the active top-level block and flush when the selection moves to
	 * a different block. Pass to the TipTap editor's `onSelectionUpdate`.
	 */
	onSelectionUpdate: (editor: Editor) => void;
}

const normalizeMd = (s: string): string => s.replace(/\s+$/g, "").trimStart();

const nextFrame = (): Promise<void> =>
	new Promise((resolve) => {
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
		else setTimeout(resolve, 0);
	});

async function applySnapshotContent(
	ed: Editor,
	proseMirror: Element | null,
	html: string,
): Promise<void> {
	const reduced =
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const shouldSettle = !!proseMirror && !reduced;
	if (shouldSettle) {
		const element = proseMirror as HTMLElement;
		element.style.transition = "opacity var(--motion-base) ease";
		element.style.opacity = "0.72";
		await nextFrame();
	}
	ed.commands.setContent(html);
	if (shouldSettle) {
		const element = proseMirror as HTMLElement;
		await nextFrame();
		element.style.opacity = "1";
		setTimeout(() => {
			element.style.transition = "";
			element.style.opacity = "";
		}, 200);
	}
}

/**
 * Capture human block edits as suggestions while in "suggesting" mode.
 *
 * Edits never touch the file. On flush we diff each top-level block against
 * the snapshot, emit a `suggestion.add` for every changed/added/removed block,
 * reload the sidecar so cards render, then resolve the editor to the snapshot
 * only after every post succeeds.
 */
export function useSuggestionCapture({
	path,
	editorRef,
	scrollContainerRef,
	isLoadingRef,
	isViewingRef,
	enabled = true,
}: UseSuggestionCaptureOptions): SuggestionCaptureControls {
	const suggestDirtyRef = useRef(false);
	const flushingRef = useRef(false);
	const activeBlockIndexRef = useRef<number | null>(null);
	const retryDecisionsRef = useRef<SuggestionCaptureDecision[]>([]);

	const flush = useCallback(async () => {
		if (flushingRef.current) return;
		if (!enabled) return;
		if (isViewingRef.current) return;
		if (useEditorStore.getState().editMode !== "suggesting") return;
		if (!suggestDirtyRef.current) return;

		const ed = editorRef.current;
		const activePath = path ?? useEditorStore.getState().currentPath;
		if (!ed || !activePath) return;

		const proseMirror = scrollContainerRef.current?.querySelector(".ProseMirror");
		if (!proseMirror) return;

		const children = Array.from(proseMirror.children) as HTMLElement[];
		const snapBlocks =
			useProofStore.getState().byPath[activePath]?.snapshotBlocks ?? [];
		if (snapBlocks.length === 0) return;

		flushingRef.current = true;
		suggestDirtyRef.current = false;

		try {
			const getRevision = () =>
				useProofStore.getState().byPath[activePath]?.snapshotRevision ?? 0;
			const refresh = async () => {
				await useProofStore.getState().loadSnapshot(activePath);
				await useProofStore.getState().loadSidecar(activePath);
			};
			const currentBlocks = children.map((el) =>
				htmlToMarkdown(el.outerHTML, activePath).trim(),
			);
			const decisions = retryDecisionsRef.current.length
				? retryDecisionsRef.current
				: decideSuggestionCaptures(currentBlocks, snapBlocks);
			if (decisions.length === 0) return;

			const result = await captureSuggestionBatch({
				path: activePath,
				decisions,
				getRevision,
				refresh,
			});
			if (result.failed.length > 0) {
				// Keep the live document. It is now an ordinary dirty draft, and
				// only failed operations are retried so successful posts are not
				// duplicated.
				retryDecisionsRef.current = result.failed;
				suggestDirtyRef.current = true;
				useEditorStore.getState().promoteSuggestionDraft();
				if (result.captured.length > 0) {
					try {
						await refresh();
					} catch {
						// Sidecar refresh is best-effort; typed content remains intact.
					}
				}
				showError("Could not post suggestion. Your edits were kept.", {
					action: { label: "Retry", onClick: () => void flush() },
				});
				return;
			}

			retryDecisionsRef.current = [];
			if (result.shouldRevert) {
				await refresh();
				const freshSnap =
					useProofStore.getState().byPath[activePath]?.snapshotBlocks ??
					snapBlocks;
				const snapshotMarkdown = freshSnap.map((b) => b.markdown).join("\n\n");
				isLoadingRef.current = true;
				const html = await markdownToHtml(snapshotMarkdown, activePath);
				useEditorStore.getState().resolveSuggestionDraft(snapshotMarkdown);
				await applySnapshotContent(ed, proseMirror, html);
				setTimeout(() => {
					isLoadingRef.current = false;
				}, 50);
			}
		} catch {
			// Network and refresh failures never justify replacing live user text.
			suggestDirtyRef.current = true;
			useEditorStore.getState().promoteSuggestionDraft();
			showError("Could not post suggestion. Your edits were kept.", {
				action: { label: "Retry", onClick: () => void flush() },
			});
		} finally {
			flushingRef.current = false;
		}
	}, [enabled, path, editorRef, scrollContainerRef, isLoadingRef, isViewingRef]);

	const markDirty = useCallback(() => {
		if (!enabled) return;
		if (isViewingRef.current) return;
		if (useEditorStore.getState().editMode !== "suggesting") return;
		suggestDirtyRef.current = true;
	}, [enabled, isViewingRef]);

	const onSelectionUpdate = useCallback(
		(editor: Editor) => {
			if (useEditorStore.getState().editMode !== "suggesting") return;
			const { from } = editor.state.selection;
			const $pos = editor.state.doc.resolve(from);
			const idx = $pos.depth > 0 ? $pos.index(0) : 0;
			const prev = activeBlockIndexRef.current;
			activeBlockIndexRef.current = idx;
			if (prev !== null && prev !== idx && suggestDirtyRef.current) {
				void flush();
			}
		},
		[flush],
	);

	return { markDirty, flush, onSelectionUpdate };
}
