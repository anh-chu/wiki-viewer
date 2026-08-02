"use client";

import { useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { captureSuggestion } from "@/lib/proof/suggest-capture";
import { useProofStore } from "@/stores/proof-store";
import { useEditorStore } from "@/stores/editor-store";

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
	/** Flush pending block edits as human suggestions and revert to snapshot. */
	flush: () => Promise<void>;
	/**
	 * Track the active top-level block and flush when the selection moves to
	 * a different block. Pass to the TipTap editor's `onSelectionUpdate`.
	 */
	onSelectionUpdate: (editor: Editor) => void;
}

const normalizeMd = (s: string): string => s.replace(/\s+$/g, "").trimStart();

/**
 * Capture human block edits as suggestions while in "suggesting" mode.
 *
 * Edits never touch the file. On flush we diff each top-level block against
 * the snapshot, emit a `suggestion.add` for every changed/added/removed block,
 * reload the sidecar so cards render, then revert the editor to the snapshot.
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

			const count = Math.max(children.length, snapBlocks.length);
			let captured = false;

			for (let i = 0; i < count; i++) {
				const el = children[i];
				const snap = snapBlocks[i];
				const curMd = el ? htmlToMarkdown(el.outerHTML, activePath).trim() : null;

				if (snap && curMd !== null) {
					if (normalizeMd(curMd) !== normalizeMd(snap.markdown)) {
						const ok = await captureSuggestion({
							path: activePath,
							ref: snap.ref,
							kind: "replace",
							markdown: curMd,
							getRevision,
							refresh,
						});
						captured = captured || ok;
					}
				} else if (snap && curMd === null) {
					const ok = await captureSuggestion({
						path: activePath,
						ref: snap.ref,
						kind: "delete",
						getRevision,
						refresh,
					});
					captured = captured || ok;
				} else if (!snap && curMd !== null && curMd.length > 0) {
					const lastRef = snapBlocks[snapBlocks.length - 1]?.ref;
					if (lastRef) {
						const ok = await captureSuggestion({
							path: activePath,
							ref: lastRef,
							kind: "insertAfter",
							markdown: curMd,
							getRevision,
							refresh,
						});
						captured = captured || ok;
					}
				}
			}

			if (captured) {
				await refresh();
				const freshSnap =
					useProofStore.getState().byPath[activePath]?.snapshotBlocks ??
					snapBlocks;
				const snapshotMarkdown = freshSnap.map((b) => b.markdown).join("\n\n");
				isLoadingRef.current = true;
				const html = await markdownToHtml(snapshotMarkdown, activePath);
				ed.commands.setContent(html);
				setTimeout(() => {
					isLoadingRef.current = false;
				}, 50);
			}
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
