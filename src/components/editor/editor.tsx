"use client";

import { cellAround, isInTable } from "@tiptap/pm/tables";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { AlertCircle, Check, Code2, FilePlus, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { parseFrontmatter } from "@/lib/markdown/parse-frontmatter";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useEditorStore } from "@/stores/editor-store";
import {
	useViewWidthStore,
	VIEW_WIDTH_CSS,
	VIEW_ALIGN_ML,
} from "@/stores/view-width-store";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import { useProofStore } from "@/stores/proof-store";
import type { Comment as ProofComment, TextRangeAnchor } from "@/lib/proof/types";
import { wsFetch, withWs } from "@/lib/workspace-client";
import { showError } from "@/lib/toast";
import { EditorBubbleMenu } from "./bubble-menu";
import { EditorToolbar } from "./editor-toolbar";
import { editorExtensions } from "./extensions";
import { resolveWikiLink } from "./link-navigation";
import { useDocumentPresence } from "./hooks/use-document-presence";
import { useDocumentWatch } from "./hooks/use-document-watch";
import { CommentPip } from "./comment-pip";
import { SuggestionPip } from "./suggestion-pip";
import { CommentThread } from "./comment-thread";
import { CommentMargin } from "./comment-margin";
import { SuggestEditPopover } from "./suggest-edit-popover";
import { SuggestionReviewPopover } from "./suggestion-review-popover";
import {
	createSuggestionDecoratorPlugin,
	type SuggestionDecoratorController,
} from "@/lib/proof/suggestion-decorator";
import { SlashCommands } from "./slash-commands";
import { DocumentOutline } from "./document-outline";
import { ReadingExperiments } from "./experiments";
import { BacklinksPanel } from "./backlinks-panel";
import { TableMenu } from "./table-menu";
import {
	useWikiLinkCreate,
	type WikiCreateResult,
} from "./wiki-link-create-dialog";
import { WikiLinkPicker } from "./wiki-link-picker";
import { FrontmatterHeader } from "@/components/wiki/frontmatter-header";
import { ViewModeCommentButton } from "./view-mode-comment-button";
import { CopyAsPrompt } from "./copy-as-prompt";
import {
	alignByStampedRef,
	type BlockElementLike,
} from "@/lib/proof/pip-alignment";
import { shouldRerenderDocument } from "@/lib/proof/render-guard";
import { commentHighlightExtension, refreshCommentHighlights } from "./extensions/comment-highlight";

async function uploadFile(
	pagePath: string,
	file: File,
): Promise<string | null> {
	const formData = new FormData();
	formData.append("file", file);
	try {
		const res = await wsFetch(`/api/upload/${pagePath}`, {
			method: "POST",
			body: formData,
		});
		if (!res.ok) {
			showError(`Upload failed: ${file.name}`);
			return null;
		}
		const data = await res.json();
		// withWs so the live <img>/<a> request resolves to the active workspace.
		return data.url ? withWs(data.url) : data.url;
	} catch {
		showError(`Upload failed: ${file.name}`);
		return null;
	}
}

/**
 * Find an element by fragment identifier, with proper URL-decoding.
 * Iterates through container's elements comparing element.id for exact match.
 */
function findElementByFragment(
	fragment: string,
	container: Document | Element = document,
): HTMLElement | null {
	let decodedId = fragment;
	try {
		decodedId = decodeURIComponent(fragment);
	} catch {
		// Invalid encoding; use as-is
	}

	// First try: direct getElementById (fallback if element has decoded ID in document scope)
	const direct = document.getElementById(decodedId);
	if (direct) return direct;

	// Second try: iterate container's headings comparing element.id
	// This handles edge cases where ID might not match document's global getElementById
	const headings = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
	for (const heading of headings) {
		if (heading.id === decodedId) {
			return heading as HTMLElement;
		}
	}

	return null;
}

type KBEditorMode = "viewing" | "editing";

interface KBEditorProps {
	mode?: KBEditorMode;
}

export function KBEditor({ mode }: KBEditorProps = {}) {
	const {
		currentPath,
		content,
		saveStatus,
		frontmatter,
		isLoading,
		loadStatus,
		createMissingPage,
	} = useEditorStore();
	const effectiveMode = mode ?? "editing";
	const isViewing = effectiveMode === "viewing";
	const parsedViewingContent = useMemo(
		() => (isViewing ? parseFrontmatter(content) : { data: {}, body: content }),
		[content, isViewing],
	);
	const editorMaxW = useViewWidthStore((s) => VIEW_WIDTH_CSS[s.width]);
	const editorMl = useViewWidthStore((s) => VIEW_ALIGN_ML[s.align]);
	const isRtl = isViewing
		? parsedViewingContent.data.dir === "rtl"
		: frontmatter?.dir === "rtl";
	const { open: openAI, clearMessages } = useAIPanelStore();
	const { open: openWikiCreate, Dialog: WikiCreateDialog } =
		useWikiLinkCreate();
	// Keep a stable ref so the click handler closure can call the latest version
	// without being re-created on every render.
	const openWikiCreateRef =
		useRef<(slug: string) => Promise<WikiCreateResult>>(openWikiCreate);
	openWikiCreateRef.current = openWikiCreate;

	const isLoadingRef = useRef(false);
	const isViewingRef = useRef(isViewing);
	isViewingRef.current = isViewing;
	const editorRef = useRef<Editor | null>(null);
	const [sourceMode, setSourceMode] = useState(false);
	const [sourceText, setSourceText] = useState("");

	// Prime the slug index once on mount so wiki-link broken-state and
	// the autocomplete picker both have data immediately.
	useEffect(() => {
		void useWikiSlugsStore.getState().load();
	}, []);

	// Load sidecar when the current path changes. Debounced: rapid navigation
	// otherwise fires a sidecar fetch per pass-through file, flooding the
	// connection pool. The cleanup clears the timer, so only the settled path loads.
	useEffect(() => {
		if (!currentPath) return;
		const id = setTimeout(() => {
			void useProofStore.getState().loadSidecar(currentPath);
		}, 200);
		return () => clearTimeout(id);
	}, [currentPath]);

	// Document presence heartbeat: tell the server a human has this markdown doc
	// open so computeCollabState() reports "active" even before the first
	// suggestion/comment. Only markdown files participate in the collab-state machine.
	useDocumentPresence({ path: currentPath, mode: effectiveMode, enabled: true });

	// Subscribe to filesystem changes for the open file's parent directory.
	// The hook recreates the EventSource on path or workspace changes and on
	// degraded/rescan reloads the snapshot+sidecar. Lite mode has no watcher.
	useDocumentWatch({ path: currentPath, isViewingRef });

	/**
	 * Ref to the editor scroll container. Used to compute block positions
	 * relative to the scrollable area for suggestion cards and comment pips.
	 *
	 * Phase D coordination: comment-pip positioning uses this same ref and the
	 * same blockRefPositions map computed below.
	 */
	const scrollContainerRef = useRef<HTMLDivElement>(null);

	/** Map of block ref → position relative to scroll container */
	const [blockRefPositions, setBlockRefPositions] = useState<
		Map<string, { top: number; left: number; width: number; bottom: number }>
	>(new Map());

	// Subscribe to snapshot data for suggestion cards.
	// NOTE: select the RAW stored references here — returning a freshly built
	// array (e.g. `?? []` or `.filter(...)`) on every call makes
	// useSyncExternalStore think the snapshot changed each render, which spins
	// into a "Maximum update depth exceeded" loop. Derive defaults/filters below.
	const snapshotBlocksRaw = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.snapshotBlocks : undefined
	);
	const suggestionsRaw = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.sidecar?.suggestions : undefined
	);
	const snapshotRevision = useProofStore((s) =>
		currentPath ? (s.byPath[currentPath]?.snapshotRevision ?? 0) : 0
	);
	const commentsRaw = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.sidecar?.comments : undefined
	);

	const snapshotBlocks = useMemo(() => snapshotBlocksRaw ?? [], [snapshotBlocksRaw]);
	// Tier-2 snapshots include leading frontmatter blocks, while the viewing
	// editor renders parsedViewingContent.body. Find the first body block in the
	// snapshot; prefix matching handles body content containing later blocks too.
	const snapshotBlockOffset = useMemo(() => {
		if (!isViewing || Object.keys(parsedViewingContent.data).length === 0) return 0;
		const body = parsedViewingContent.body.trim();
		if (!body) return 0;
		// Count blocks that consume the parsed frontmatter prefix first. This
		// disambiguates a body thematic break (`---`) from the opening fence.
		let frontmatterOffset = 0;
		let prefix = content.slice(0, content.length - parsedViewingContent.body.length).trimStart();
		for (const block of snapshotBlocks) {
			const markdown = block.markdown.trim();
			if (!markdown || !prefix.startsWith(markdown)) break;
			frontmatterOffset += 1;
			prefix = prefix.slice(markdown.length).trimStart();
		}
		const firstBodyIndex = snapshotBlocks.findIndex((block, index) => {
			if (index < frontmatterOffset) return false;
			const markdown = block.markdown.trim();
			return markdown !== "" && (body === markdown || body.startsWith(`${markdown}\n`));
		});
		return firstBodyIndex >= 0 ? firstBodyIndex : frontmatterOffset;
	}, [content, isViewing, parsedViewingContent.body, parsedViewingContent.data, snapshotBlocks]);
	const comments = useMemo(() => commentsRaw ?? [], [commentsRaw]);
	const pendingSuggestions = useMemo(
		() => suggestionsRaw?.filter((sg) => sg.status === "pending" && !sg.stale) ?? [],
		[suggestionsRaw],
	);
	const pendingSuggestionsByRef = useMemo(() => {
		const grouped = new Map<string, typeof pendingSuggestions>();
		for (const suggestion of pendingSuggestions) {
			const byRef = grouped.get(suggestion.ref) ?? [];
			byRef.push(suggestion);
			grouped.set(suggestion.ref, byRef);
		}
		return grouped;
	}, [pendingSuggestions]);
	const [reviewTarget, setReviewTarget] = useState<{
		suggestionId: string;
		anchor: { top: number; left: number };
	} | null>(null);
	const openSuggestionReview = useCallback(
		(suggestionId: string, element?: HTMLElement, shouldScroll = false) => {
			const marker =
				element ??
				Array.from(
					scrollContainerRef.current?.querySelectorAll<HTMLElement>(
						"[data-suggestion-gutter]",
					) ?? [],
				).find((candidate) => candidate.dataset.suggestionId === suggestionId);
			if (!marker) return;
			if (shouldScroll) {
				marker.scrollIntoView({ block: "center" });
			}
			const rect = marker.getBoundingClientRect();
			setReviewTarget({
				suggestionId,
				anchor: { top: rect.bottom, left: rect.left },
			});
		},
		[],
	);
	const suggestionDecoratorRef = useRef<SuggestionDecoratorController | null>(null);
	if (!suggestionDecoratorRef.current) {
		suggestionDecoratorRef.current = createSuggestionDecoratorPlugin({
			suggestions: [],
			blocks: [],
		});
	}
	const suggestionBlocks = useMemo(
		() => snapshotBlocks.slice(snapshotBlockOffset),
		[snapshotBlockOffset, snapshotBlocks],
	);

	/**
	 * Resolve a block `ref` to its full canonical markdown for the
	 * Copy-as-prompt surface, so the exported prompt quotes the text the
	 * annotation is anchored to (the serializer caps the quoted length).
	 */
	const promptComments = useMemo(() => comments, [comments]);
	const resolvePromptSnippet = useMemo(() => {
		const byRef = new Map(snapshotBlocks.map((b) => [b.ref, b.markdown]));
		// Full canonical block markdown: the receiving agent locates the anchor
		// by its actual text (the serializer caps the quoted length). Line
		// ranges are unavailable for ref anchors here, so they are omitted —
		// line-anchored comments carry their own LineAnchor.
		return (annotation: { ref?: string }) => {
			const md = annotation.ref ? byRef.get(annotation.ref) : undefined;
			const text = md?.replace(/\s+/g, " ").trim();
			return text ? { text } : undefined;
		};
	}, [snapshotBlocks]);

	/** Group human comments by block ref for pip rendering (instructions have their own variant). */
	const commentsByRef = useMemo(() => {
		const map: Record<string, typeof comments> = {};
		for (const c of comments) {
			if (!c.ref || c.kind === "instruction") continue;
			(map[c.ref] ??= []).push(c);
		}
		return map;
	}, [comments]);
	const draftInstructionsByRef = useMemo(() => {
		const map: Record<string, typeof comments> = {};
		for (const c of comments) {
			if (!c.ref || c.kind !== "instruction" || c.instructionState !== "draft") continue;
			(map[c.ref] ??= []).push(c);
		}
		return map;
	}, [comments]);
	const threadCommentsByRef = useMemo(() => {
		const map: Record<string, typeof comments> = {};
		for (const c of comments) {
			if (c.ref && (c.kind !== "instruction" || c.instructionState === "draft")) (map[c.ref] ??= []).push(c);
		}
		return map;
	}, [comments]);

	/** Tracks which block's comment thread is open and its anchor element. */
	const [threadTarget, setThreadTarget] = useState<
		{ blockRef: string; el: HTMLElement; textAnchor?: TextRangeAnchor } | null
	>(null);

	/**
	 * Google-Docs-style margin data.
	 *
	 * Every block that has comments becomes a card in the right-hand column,
	 * persistently visible. Cards WITHOUT a resolved anchor offset still appear
	 * (the layout defaults them to the top) rather than silently disappearing —
	 * a comment you cannot see is indistinguishable from a comment that was lost.
	 */
	const marginThreads = useMemo(
		() =>
			Object.entries(threadCommentsByRef)
				// A cancelled comment has nothing left to point at, so it is not shown.
				// Resolved threads leave the column too, rather than sitting there as
				// dead weight next to live ones.
				.map(([blockRef, list]) => ({
					blockRef,
					comments: list.filter((c) => !c.resolved && !c.cancelledAt),
				}))
				.filter((t) => t.comments.length > 0),
		[threadCommentsByRef],
	);
	const marginOffsets = useMemo(() => {
		const map = new Map<string, number>();
		for (const [ref, pos] of blockRefPositions) map.set(ref, pos.top);
		return map;
	}, [blockRefPositions]);
	const [hoveredMarginRef, setHoveredMarginRef] = useState<string | null>(null);
	// The column is hidden when nothing is commented, and can be collapsed by
	// hand so it never steals width from the document uninvited.
	const [marginCollapsed, setMarginCollapsed] = useState(false);
	const showCommentMargin = marginThreads.length > 0 && !marginCollapsed;

	/** Tracks the open human "suggest edit" popover (block + anchor + content). */
	const [suggestTarget, setSuggestTarget] = useState<
		{ blockRef: string; markdown: string; anchor: { top: number; left: number } } | null
	>(null);

	/**
	 * Resolve the current editor selection to a top-level block.
	 *
	 * Primary strategy: map the selection to its top-level ProseMirror child
	 * INDEX, then look up the corresponding snapshot block after skipping
	 * frontmatter blocks. This is robust even when the DOM `data-block-ref`
	 * annotation has not been applied yet (e.g. snapshot still loading). Falls
	 * back to walking the DOM for an existing [data-block-ref].
	 */
	const resolveSelectionBlock = useCallback((): {
		blockRef: string;
		blockEl: HTMLElement;
		markdown: string;
		selectionText: string | null;
		selectionStart: number | null;
		selectionEnd: number | null;
	} | null => {
		if (!editorRef.current) return null;
		const view = editorRef.current.view;
		const { from, to } = view.state.selection;
		const path = useEditorStore.getState().currentPath ?? "";
		const blocks = useProofStore.getState().byPath[path]?.snapshotBlocks ?? [];

		const proseMirror = scrollContainerRef.current?.querySelector(".ProseMirror");
		const children = proseMirror
			? (Array.from(proseMirror.children) as HTMLElement[])
			: [];

		// Resolve the top-level block index. In edit mode ProseMirror owns the
		// selection. In read-only view mode PM selection stays collapsed/stale, so
		// the user's native browser selection drives block resolution instead.
		const nativeSel =
			typeof window !== "undefined" ? window.getSelection() : null;
		const nativeActive =
			!!nativeSel &&
			!nativeSel.isCollapsed &&
			nativeSel.rangeCount > 0 &&
			!!proseMirror &&
			proseMirror.contains(nativeSel.getRangeAt(0).commonAncestorContainer);

		let topIndex: number;
		if (nativeActive && from === to) {
			// View mode: find which top-level child contains the native selection.
			const anchorNode = nativeSel.getRangeAt(0).commonAncestorContainer;
			const anchorEl =
				anchorNode.nodeType === Node.ELEMENT_NODE
					? (anchorNode as HTMLElement)
					: anchorNode.parentElement;
			const idx = children.findIndex((c) => c === anchorEl || c.contains(anchorEl));
			if (idx < 0) return null;
			topIndex = idx;
		} else {
			const $pos = view.state.doc.resolve(from);
			topIndex = $pos.depth > 0 ? $pos.index(0) : 0;
		}

		const blockEl = children[topIndex] ?? null;

		// Prefer the offset-aligned snapshot block; fall back to the DOM attr.
		const block = blocks[topIndex + snapshotBlockOffset];
		let blockRef: string | null =
			block?.ref ?? blockEl?.getAttribute("data-block-ref") ?? null;
		const markdown = block?.markdown ?? "";

		if (!blockRef && blockEl) {
			// Last-resort: DOM walk from the selection anchor.
			const found = blockEl.closest<HTMLElement>("[data-block-ref]") ?? null;
			blockRef = found?.getAttribute("data-block-ref") ?? null;
		}

		if (!blockRef || !blockEl) return null;

		// Precise-pointing selection capture. PM doc offsets are NOT
		// markdown-string offsets, so selectionStart/End are best-effort:
		// we locate the plain selected text inside the block markdown via
		// indexOf rather than trusting PM positions. Offsets may be null
		// (text not found / markdown differs) while selectionText is still
		// populated.
		let selectionText: string | null = null;
		let selectionStart: number | null = null;
		let selectionEnd: number | null = null;
		if (from !== to && view.state.doc.resolve(to).index(0) === topIndex) {
			// Edit mode: ProseMirror owns the selection.
			const raw = view.state.doc.textBetween(from, to, "\n");
			selectionText = raw.length > 0 ? raw : null;
		} else if (nativeActive) {
			// View mode: the native browser selection is authoritative. Keep it
			// only if it lies within the resolved block element.
			const range = nativeSel.getRangeAt(0);
			if (blockEl.contains(range.commonAncestorContainer)) {
				const raw = nativeSel.toString();
				selectionText = raw.length > 0 ? raw : null;
			}
		}
		if (selectionText && markdown) {
			const idx = markdown.indexOf(selectionText);
			if (idx >= 0) {
				selectionStart = idx;
				selectionEnd = idx + selectionText.length;
			}
		}

		return { blockRef, blockEl, markdown, selectionText, selectionStart, selectionEnd };
	}, [snapshotBlockOffset]);

	const openSuggestForSelection = useCallback(() => {
		const resolved = resolveSelectionBlock();
		if (!resolved) return;
		const rect = resolved.blockEl.getBoundingClientRect();
		setSuggestTarget({
			blockRef: resolved.blockRef,
			markdown: resolved.markdown,
			anchor: { top: rect.bottom + 4, left: rect.left },
		});
	}, [resolveSelectionBlock]);

	const openCommentForSelection = useCallback(() => {
		const resolved = resolveSelectionBlock();
		if (!resolved) return;
		const spanEl = scrollContainerRef.current?.querySelector(
			`[data-annotation-span="${resolved.blockRef}"]`,
		) as HTMLElement | null;
		// Carry the selected RANGE, not just the block. Without this the comment
		// degrades to block granularity: the highlight covers the whole block and
		// the anchor has no text to be found by after an edit. `resolveSelectionBlock`
		// already computes the offsets; this is where they used to be dropped.
		const textAnchor =
			resolved.selectionText && resolved.selectionStart !== null && resolved.selectionEnd !== null
				? {
						start: resolved.selectionStart,
						end: resolved.selectionEnd,
						selectedText: resolved.selectionText,
						baseMarkdown: resolved.markdown,
					}
				: undefined;
		setThreadTarget({
			blockRef: resolved.blockRef,
			el: spanEl ?? resolved.blockEl,
			textAnchor,
		});
	}, [resolveSelectionBlock]);

	// Load snapshot (ordered block list) when path changes so suggestion cards
	// can look up block content by ref.
	useEffect(() => {
		if (!currentPath) return;
		const id = setTimeout(() => {
			void useProofStore.getState().loadSnapshot(currentPath);
		}, 200);
		return () => clearTimeout(id);
	}, [currentPath]);

	/**
	 * After content renders, walk `.ProseMirror > *` to build ref→position map.
	 * Skip snapshot blocks belonging to frontmatter, which is rendered outside
	 * ProseMirror in viewing mode.
	 *
	 * Phase D coordination: this effect also annotates each child element with
	 * data-block-ref for any consumer that needs CSS/query-based lookup.
	 */
	useEffect(() => {
		if (!currentPath || snapshotBlocks.length === 0 || !scrollContainerRef.current) return;
		const container = scrollContainerRef.current;
		const proseMirror = container.querySelector(".ProseMirror");
		if (!proseMirror) return;
		const children = Array.from(proseMirror.children) as HTMLElement[];
		// A viewing-mode filesystem refresh briefly clears ProseMirror before the
		// replacement HTML is stamped in. Keep the last known positions during that
		// gap so annotation pips and an open thread do not disappear and reappear.
		if (children.length === 0) return;
		const containerRect = container.getBoundingClientRect();

		// Phase 4: key on IDENTITY, never on DOM-child index.
		//
		// The previous loop paired `children[i]` with `snapshotBlocks[i + offset]`
		// and truncated with Math.min. mdast→Tiptap is not 1:1 — a loose list
		// renders as <ul> + <li>s, a table as <table> + rows, a blockquote wraps a
		// paragraph — so any expansion shifted every later pairing and made
		// `Math.min` drop the tail silently. Three comments on three blocks could
		// render one pip, or a pip in the wrong place.
		//
		// Each block element is stamped with the ref that rendered it. We now read
		// that ref back, and walk the SHALLOWEST matching element for nested cases
		// so an <li> is never mistaken for its list.
		const elements: BlockElementLike[] = children.map((el) => ({
			getAttribute: (name: string) => el.getAttribute(name),
			measure: () => {
				const rect = el.getBoundingClientRect();
				return {
					top: rect.top - containerRect.top + container.scrollTop,
					left: rect.left - containerRect.left,
					width: rect.width,
					bottom: rect.bottom - containerRect.top + container.scrollTop,
				};
			},
		}));

		// Stamp refs by identity where the element carries none yet: match the
		// element's own rendering to the snapshot by position ONLY as a last
		// resort for the initial paint, and never beyond the shorter sequence.
		// Once stamped, every subsequent pass resolves by identity.
		const stamped = alignByStampedRef(elements, snapshotBlocks, snapshotBlockOffset);
		if (stamped.positions.size === 0 && children.length <= snapshotBlocks.length) {
			// First paint (no refs stamped yet) — fall back to position, which is
			// correct only while the sequences agree, but is better than no pips.
			for (
				let i = 0;
				i < Math.min(children.length, snapshotBlocks.length - snapshotBlockOffset);
				i += 1
			) {
				children[i].setAttribute("data-block-ref", snapshotBlocks[i + snapshotBlockOffset].ref);
			}
			const restamped = alignByStampedRef(elements, snapshotBlocks, snapshotBlockOffset);
			setBlockRefPositions(restamped.positions);
			return;
		}

		setBlockRefPositions(stamped.positions);

		// Fail loudly in development rather than silently rendering fewer pips:
		// an unresolved ref means the doc/snapshot disagree, which is exactly the
		// condition that used to be invisible.
		if (process.env.NODE_ENV !== "production" && stamped.unmatchedRefs.length > 0) {
			console.warn(
				`[editor] ${stamped.unmatchedRefs.length} annotated block(s) have no rendered element:`,
				stamped.unmatchedRefs,
			);
		}
	}, [currentPath, snapshotBlockOffset, snapshotBlocks]);


	const handleUpdate = useCallback(
		({ editor }: { editor: ReturnType<typeof useEditor> }) => {
			if (isLoadingRef.current || isViewingRef.current || !editor) return;
			const html = editor.getHTML();
			const md = htmlToMarkdown(
				html,
				useEditorStore.getState().currentPath ?? undefined,
			);
			useEditorStore.getState().updateContent(md);
		},
		[],
	);

	// Exact-word comment highlights. The extension reads live state through a ref
	// so the plugin never captures a stale comment set — the annotations live in
	// the sidecar store, not in the document, and change without a doc transaction.
	const commentHighlightStateRef = useRef<{
		blocks: { ref: string; markdown: string }[];
		comments: ProofComment[];
		hoveredRef?: string | null;
	}>({ blocks: [], comments: [] });
	commentHighlightStateRef.current = {
		blocks: snapshotBlocks.map((b) => ({ ref: b.ref, markdown: b.markdown })),
		comments,
		hoveredRef: hoveredMarginRef,
	};
	const extensions = useMemo(
		() =>
			[
				...editorExtensions,
				commentHighlightExtension(() => commentHighlightStateRef.current),
			] as typeof editorExtensions,
		[],
	);

	const editor = useEditor({
		extensions,
		content: "",
		editable: !isViewing,
		onUpdate: handleUpdate,
		editorProps: {
			attributes: {
				class:
					"focus:outline-none min-h-[calc(100vh-12rem)] px-4 sm:px-8 py-6 max-w-[var(--editor-max-w,48rem)] ml-[var(--editor-ml,auto)] mr-auto",
			},
			handleKeyDown: (view, event) => {
				if (
					(event.metaKey || event.ctrlKey) &&
					event.key.toLowerCase() === "a" &&
					isInTable(view.state)
				) {
					const $cell = cellAround(view.state.selection.$from);
					const cell = $cell?.nodeAfter;
					if (!$cell || !cell) return false;

					const from = $cell.pos + 1;
					const to = $cell.pos + cell.nodeSize - 1;
					if (
						view.state.selection.from === from &&
						view.state.selection.to === to
					) {
						return false;
					}

					event.preventDefault();
					editor?.chain().focus().setTextSelection({ from, to }).run();
					return true;
				}

				return false;
			},
			handleClick: (_view, _pos, event) => {
				const target = event.target as HTMLElement;
				const link = target.closest("a") as HTMLAnchorElement | null;
				if (!link) return false;

				const href = link.getAttribute("href");
				if (!href) return false;

				// Wiki-links inserted by the WikiLink mark
				if (link.dataset.wikiLink === "true") {
					event.preventDefault();
					event.stopPropagation();
					const slug = link.dataset.slug ?? "";
					const anchor = link.dataset.anchor ?? null;
					if (!slug) return true;

					const slugStore = useWikiSlugsStore.getState();
					if (slugStore.has(slug)) {
						const dir = slugStore.getDir(slug);
						const pagePath =
							dir === null || dir === "root"
								? `${slug}.md`
								: `${dir}/${slug}.md`;
						void useEditorStore.getState().loadPage(pagePath);
						if (anchor) {
							setTimeout(() => {
								const anchorEl = findElementByFragment(anchor);
								if (anchorEl) {
									anchorEl.scrollIntoView({ behavior: "smooth" });
									// Dispatch custom event for anchor-flash experiment
									document.dispatchEvent(
										new CustomEvent("anchor-navigation", {
											detail: { element: anchorEl },
										}),
									);
								}
							}, 200);
						}
					} else if (isViewingRef.current) {
						return true;
					} else {
						void openWikiCreateRef.current(slug).then((result) => {
							if (result.ok) {
								const dir = result.dir ?? "entities";
								const pagePath = `${dir}/${result.slug}.md`;
								void useEditorStore.getState().loadPage(pagePath);
							}
						});
					}
					return true;
				}

				// Internal links: relative paths to .md files or other KB pages.
				// Skip external URLs and API asset links.
				if (/^https?:\/\//.test(href) || href.startsWith("/api/")) return false;
				if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;

				event.preventDefault();
				event.stopPropagation();

				// Check if this is a fragment-only link (e.g., #section)
				if (href.startsWith("#")) {
					const fragment = href.slice(1);
					const anchorEl = findElementByFragment(fragment);
					if (anchorEl) {
						anchorEl.scrollIntoView({ behavior: "smooth" });
						document.dispatchEvent(
							new CustomEvent("anchor-navigation", {
								detail: { element: anchorEl },
							}),
						);
					}
					return true;
				}

				const activePath = useEditorStore.getState().currentPath;
				const targetPath = resolveWikiLink(
					href,
					activePath,
					useWikiSlugsStore.getState(),
				);
				if (targetPath) {
					void useEditorStore.getState().loadPage(targetPath);
					const hash = href.includes("#")
						? href.slice(href.indexOf("#") + 1)
						: "";
					if (hash) {
						setTimeout(() => {
							const anchorEl = findElementByFragment(hash);
							if (anchorEl) {
								anchorEl.scrollIntoView({ behavior: "smooth" });
								document.dispatchEvent(
									new CustomEvent("anchor-navigation", {
										detail: { element: anchorEl },
									}),
								);
							}
						}, 200);
					}
				}
				return true;
			},
			handlePaste: (_view, event) => {
				if (isViewingRef.current) return false;
				const files = event.clipboardData?.files;
				const pagePath = useEditorStore.getState().currentPath;

				// 1. File paste → upload then insert appropriate node
				if (files && files.length > 0 && pagePath) {
					for (const file of Array.from(files)) {
						uploadFile(pagePath, file).then((url) => {
							if (!url || !editor) return;
							if (file.type.startsWith("image/")) {
								editor
									.chain()
									.focus()
									.setImage({ src: url, alt: file.name })
									.run();
							} else {
								editor
									.chain()
									.focus()
									.insertContent(`<a href="${url}">${file.name}</a>`)
									.run();
							}
						});
					}
					return true;
				}

				return false;
			},
			handleDrop: (_view, event) => {
				if (isViewingRef.current) return false;
				const files = event.dataTransfer?.files;
				if (!files || files.length === 0) return false;

				const pagePath = useEditorStore.getState().currentPath;
				if (!pagePath) return false;

				event.preventDefault();
				for (const file of Array.from(files)) {
					uploadFile(pagePath, file).then((url) => {
						if (!url || !editor) return;
						if (file.type.startsWith("image/")) {
							editor
								.chain()
								.focus()
								.setImage({ src: url, alt: file.name })
								.run();
						} else {
							editor
								.chain()
								.focus()
								.insertContent(`<a href="${url}">${file.name}</a>`)
								.run();
						}
					});
				}
				return true;
			},
		},
		immediatelyRender: false,
	});

	/**
	 * Repaint exact-word highlights when the annotation data changes.
	 *
	 * The plugin reads live state on every transaction, but loading the snapshot
	 * and sidecar does not dispatch one — so without this the highlights would be
	 * built once against empty inputs and never appear. This is the same class of
	 * gap that made the old render guard inert.
	 */
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		refreshCommentHighlights(editor.view);
	}, [editor, snapshotBlocks, comments, currentPath, hoveredMarginRef]);

	// Stable ref to the editor so callbacks with empty deps reach the live instance.
	editorRef.current = editor;

	useEffect(() => {
		if (!editor || !suggestionDecoratorRef.current) return;
		editor.registerPlugin(suggestionDecoratorRef.current.plugin);
		return () => {
			if (!editor.isDestroyed) editor.unregisterPlugin("suggestionDecorator");
		};
	}, [editor]);

	useEffect(() => {
		if (!editor || !suggestionDecoratorRef.current) return;
		suggestionDecoratorRef.current.update({
			suggestions: pendingSuggestions,
			blocks: suggestionBlocks,
		});
		suggestionDecoratorRef.current.refresh(editor.view);
	}, [editor, pendingSuggestions, suggestionBlocks]);

	useEffect(() => {
		editor?.setEditable(!isViewing);
		if (isViewing) setSourceMode(false);
	}, [editor, isViewing]);

	// When content updates from store (after loadPage), set it in editor
	const prevPathRef = useRef<string | null>(null);
	const renderedKeyRef = useRef<string | null>(null);
	// Phase 5 (DoD #5): a fingerprint of the annotation state at the last render.
	// When it changes but the MARKDOWN does not, the change is annotation-only
	// and ProseMirror must not be rebuilt. Without this the guard's
	// `annotationChanged` input could only ever be a constant, leaving the
	// protection inert.
	const annotationFingerprint = useMemo(() => {
		const commentIds = comments.map((c) => `${c.id}:${c.resolved ? 1 : 0}:${c.turns.length}`).join(",");
		const suggestionIds = pendingSuggestions.map((s) => `${s.id}:${s.status}`).join(",");
		return `${commentIds}|${suggestionIds}`;
	}, [comments, pendingSuggestions]);
	const lastAnnotationFingerprintRef = useRef<string | null>(null);
	const [renderedPath, setRenderedPath] = useState<string | null>(null);
	useEffect(() => {
		if (!editor || currentPath === null) return;
		const renderMarkdown = parsedViewingContent.body;

		// Phase 5 (DoD #5): the single predicate that decides whether ProseMirror
		// is torn down and rebuilt. Extracted so it is testable — see
		// repro-annotation-reload.test.ts.
		//
		// The bug this removes: annotation ops (comment / reply / resolve /
		// accept) route through the zustand store, `content` is a dependency of
		// this effect, so EVERY annotation re-ran markdownToHtml + setContent and
		// destroyed selection, scroll and decorator state. That is why the
		// refresh(editor.view) patches below and in the viewing-mode effect exist.
		const decision = shouldRerenderDocument({
			editorReady: !!editor,
			currentPath,
			isDirty: useEditorStore.getState().isDirty && currentPath === prevPathRef.current,
			isLoading,
			content,
			renderMarkdown,
			lastRenderedKey: renderedKeyRef.current,
			lastRenderedPath: renderedPath,
			revisionChanged: false,
			annotationChanged:
				lastAnnotationFingerprintRef.current !== null &&
				lastAnnotationFingerprintRef.current !== annotationFingerprint,
		});
		if (!decision.rerender) {
			if (decision.reason === "already-rendered" && renderedPath !== currentPath) {
				setRenderedPath(currentPath);
			}
			// An annotation-only pass still refreshes the decoration layer, which
			// is exactly the cheap transaction path DoD #5 asks for — no
			// markdownToHtml, no setContent, selection and scroll preserved.
			if (decision.reason === "annotation-only") {
				lastAnnotationFingerprintRef.current = annotationFingerprint;
				suggestionDecoratorRef.current?.refresh(editor.view);
				// Repaint exact-word highlights too: the comment set changed and the
				// document did not, which is exactly the case a document transaction
				// cannot signal.
				refreshCommentHighlights(editor.view);
			}
			return;
		}
		prevPathRef.current = currentPath;

		// The key the guard compares against on the next pass. Same format the
		// guard builds internally, so the two cannot drift.
		const key = `${currentPath} ${renderMarkdown}`;

		let cancelled = false;
		const setContent = async () => {
			isLoadingRef.current = true;
			const html = await markdownToHtml(
				renderMarkdown,
				isViewing ? { pagePath: currentPath, sanitize: true } : currentPath,
			);
			// Rapid navigation: a newer page may have superseded this render while
			// markdownToHtml was awaiting. Don't stamp stale HTML into the editor.
			if (cancelled || useEditorStore.getState().currentPath !== currentPath) {
				isLoadingRef.current = false;
				return;
			}
			editor.commands.setContent(html);
			suggestionDecoratorRef.current?.refresh(editor.view);
			renderedKeyRef.current = key;
			lastAnnotationFingerprintRef.current = annotationFingerprint;
			setRenderedPath(currentPath);
			setTimeout(() => {
				isLoadingRef.current = false;
			}, 50);
		};

		setContent();
		return () => {
			cancelled = true;
		};
	}, [
		editor,
		content,
		currentPath,
		isLoading,
		renderedPath,
		parsedViewingContent.body,
		isViewing,
		annotationFingerprint,
	]);

	useEffect(() => {
		if (!isViewing || !renderedPath) return;
		const container = scrollContainerRef.current;
		if (!container) return;
		container
			.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
			.forEach((input) => {
				input.disabled = true;
			});
	}, [isViewing, renderedPath, parsedViewingContent.body]);

	const reviewSuggestion = reviewTarget
		? pendingSuggestions.find((suggestion) => suggestion.id === reviewTarget.suggestionId)
		: undefined;
	const reviewBlock = reviewSuggestion
		? snapshotBlocks.find((block) => block.ref === reviewSuggestion.ref)
		: undefined;
	const overlapSuggestions = reviewSuggestion
		? pendingSuggestions.filter(({ ref }) => ref === reviewSuggestion.ref)
		: [];
	const openNextSuggestion = useCallback(() => {
		if (pendingSuggestions.length === 0) return;
		const currentIndex = reviewTarget
			? pendingSuggestions.findIndex(({ id }) => id === reviewTarget.suggestionId)
			: -1;
		const next = pendingSuggestions[(currentIndex + 1) % pendingSuggestions.length];
		openSuggestionReview(next.id, undefined, true);
	}, [openSuggestionReview, pendingSuggestions, reviewTarget]);
	const isLoadingState =
		currentPath !== null && (isLoading || renderedPath !== currentPath);
	// Don't flash a spinner for fast/cached opens: only reveal the overlay if the
	// load is still pending after a grace period. Instant (prefetched/cached) opens
	// resolve well within it and never show a loader — the world-class default.
	const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
	useEffect(() => {
		if (!isLoadingState) {
			setShowLoadingOverlay(false);
			return;
		}
		const id = setTimeout(() => setShowLoadingOverlay(true), 150);
		return () => clearTimeout(id);
	}, [isLoadingState]);

	const handleOpenAI = () => {
		clearMessages();
		openAI();
	};

	if (currentPath === null) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<div className="text-center space-y-3">
					<p className="text-lg font-medium tracking-[-0.02em]">
						No page selected
					</p>
					<p className="text-sm text-muted-foreground/70">
						Select a page from the sidebar or create a new one
					</p>
				</div>
			</div>
		);
	}

	// Path resolved to a folder (or otherwise-missing target) without an
	// index.md. Render an explicit placeholder + Create CTA instead of
	// dropping the user into an empty editor that pretends to be the page.
	if (loadStatus === "missing") {
		const slug = currentPath.split("/").pop() || currentPath;
		const inferredTitle = slug
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase());
		return (
			<div className="flex-1 overflow-y-auto">
				<div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
					<div className="space-y-3">
						<p className="text-lg font-medium tracking-[-0.02em] text-foreground">
							{inferredTitle}
						</p>
						<p className="text-sm text-muted-foreground/80">
							This page doesn&apos;t exist yet.
						</p>
						<button
							onClick={() => void createMissingPage(inferredTitle)}
							className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							<FilePlus className="h-3.5 w-3.5" />
							Create page
						</button>
					</div>
				</div>
			</div>
		);
	}

	const toggleSourceMode = async () => {
		if (!sourceMode) {
			// Switching TO source mode — grab current markdown
			setSourceText(useEditorStore.getState().content);
			setSourceMode(true);
		} else {
			// Switching FROM source mode — apply changes
			useEditorStore.getState().updateContent(sourceText);
			if (editor) {
				isLoadingRef.current = true;
				const html = await markdownToHtml(sourceText, currentPath ?? undefined);
				editor.commands.setContent(html);
				suggestionDecoratorRef.current?.refresh(editor.view);
				setTimeout(() => {
					isLoadingRef.current = false;
				}, 50);
			}
			setSourceMode(false);
		}
	};

	return (
		<>
			<div className="flex-1 flex flex-col overflow-hidden">
						{!isViewing && (
							<div className="flex items-center min-w-0">
								<div className="flex-1 min-w-0">
									{!sourceMode && <EditorToolbar editor={editor} />}
								</div>
								<button
									onClick={toggleSourceMode}
									className={`flex items-center gap-1.5 px-3 py-1 mr-2 text-[11px] rounded-md transition-colors border border-border ${
										sourceMode
											? "bg-primary text-primary-foreground"
											: "text-muted-foreground hover:bg-accent"
									}`}
								>
									<Code2 className="h-3 w-3" />
									{sourceMode ? "Preview" : "Markdown"}
								</button>
							</div>
						)}

						{sourceMode ? (
							<div
								className="flex-1 overflow-y-auto p-4"
								dir={isRtl ? "rtl" : undefined}
							>
								<textarea
									value={sourceText}
									onChange={(e) => setSourceText(e.target.value)}
									className="w-full h-full min-h-[calc(100vh-12rem)] bg-transparent font-mono text-[13px] leading-relaxed resize-none focus:outline-none"
									spellCheck={false}
								/>
							</div>
						) : (
							<div className="flex-1 relative flex min-h-0" dir={isRtl ? "rtl" : undefined}>
								<DocumentOutline editor={editor} scrollContainerRef={scrollContainerRef} />
								<ReadingExperiments editor={editor} scrollContainerRef={scrollContainerRef} />
								<div className="flex-1 relative min-w-0">
								<div
									ref={scrollContainerRef}
									className="absolute inset-0 overflow-y-auto"
									style={{
										["--editor-max-w" as string]: editorMaxW,
										["--editor-ml" as string]: editorMl,
									}}
									data-editor-scroll
								>
									{/* Absolutely-positioned overlay for comment pips and suggestion cards.
									     height:0 so it doesn't push content; children overflow freely.
									     Positions from blockRefPositions are relative to scroll container top. */}
									<div
										aria-hidden="true"
										className="relative pointer-events-none"
										style={{ height: 0 }}
									>
										{/* Suggestion pips — one per block with pending suggestions,
										    placed just left of the comment pip (same line) when a block has
										    both, so gutter icons never overlap across adjacent blocks. */}
										{Array.from(pendingSuggestionsByRef.entries()).map(([blockRef, blockSuggestions]) => {
											const pos = blockRefPositions.get(blockRef);
											if (!pos) return null;
											const hasCommentPip = (threadCommentsByRef[blockRef]?.length ?? 0) > 0;
											const firstSuggestion = blockSuggestions[0];
											return (
												<SuggestionPip
													key={`suggestion-pip-${blockRef}`}
													active={reviewTarget?.suggestionId !== undefined && blockSuggestions.some((sg) => sg.id === reviewTarget.suggestionId)}
													top={pos.top + 4}
													left={Math.max(0, pos.left - (hasCommentPip ? 40 : 20))}
													count={blockSuggestions.length}
													anchorKey={blockRef}
													aria-label={`Review ${blockSuggestions.length} suggestion${blockSuggestions.length === 1 ? "" : "s"} on this block`}
													onClick={(event) =>
														openSuggestionReview(
															firstSuggestion.id,
															(scrollContainerRef.current?.querySelector(
																`[data-annotation-span="${blockRef}"]`,
															) as HTMLElement | null) ?? event.currentTarget,
														)
													}
												/>
											);
										})}

										{/* Draft instruction pips — routed instructions stay invisible. */}
										{Object.entries(draftInstructionsByRef).map(([blockRef, blockComments]) => {
											const pos = blockRefPositions.get(blockRef);
											if (!pos) return null;
											const hasCommentPip = (commentsByRef[blockRef]?.length ?? 0) > 0;
											return (
												<div key={`instruction-pip-${blockRef}`} style={{ pointerEvents: "auto" }}>
													<CommentPip
														active={threadTarget?.blockRef === blockRef}
														anchorKey={blockRef}
														anchorLabel={blockRef}
														comments={blockComments}
														top={pos.top + 4}
														left={Math.max(0, pos.left - (hasCommentPip ? 40 : 20))}
														variant="instruction"
														onClick={() => {
															const el = (scrollContainerRef.current?.querySelector(
																`[data-annotation-span="${blockRef}"]`,
																) as HTMLElement | null) ?? (scrollContainerRef.current?.querySelector(
																`[data-block-ref="${blockRef}"]`,
																) as HTMLElement | null);
															if (el) setThreadTarget({ blockRef, el });
														}}
													/>
												</div>
											);
										})}

										{/* Comment pips — one per block with at least one comment */}
										{Object.entries(commentsByRef).map(([blockRef, blockComments]) => {
											const pos = blockRefPositions.get(blockRef);
											if (!pos) return null;
											return (
												<div key={`pip-${blockRef}`} style={{ pointerEvents: "auto" }}>
							<CommentPip
								active={threadTarget?.blockRef === blockRef}
								anchorKey={blockRef}
								anchorLabel={blockRef}
								comments={blockComments}
								top={pos.top + 4}
								left={Math.max(0, pos.left - 20)}
								onClick={() => {
									// Prefer the annotation span (the measured text
									// element) so the thread anchors to the commented
									// text, not the line-start pip.
									const el =
										(scrollContainerRef.current?.querySelector(
											`[data-annotation-span="${blockRef}"]`,
										) as HTMLElement | null) ??
										(scrollContainerRef.current?.querySelector(
											`[data-block-ref="${blockRef}"]`,
										) as HTMLElement | null);
									if (el) setThreadTarget({ blockRef, el });
								}}
							/>
												</div>
											);
										})}

									</div>

									{/* Comment thread — Portal-rendered, driven by threadTarget */}
									{threadTarget && currentPath && (
						<CommentThread
							path={currentPath}
							anchorKey={threadTarget.blockRef}
							anchorRef={threadTarget.blockRef}
							anchorLabel={threadTarget.blockRef}
							textAnchor={threadTarget.textAnchor}
							comments={
								(threadCommentsByRef[threadTarget.blockRef]) ?? []
							}
							anchorEl={threadTarget.el}
							onClose={() => setThreadTarget(null)}
						/>
									)}

									{/* Human suggest-edit popover — driven by suggestTarget */}
									{suggestTarget && currentPath && (
										<SuggestEditPopover
											path={currentPath}
											blockRef={suggestTarget.blockRef}
											currentMarkdown={suggestTarget.markdown}
											anchor={suggestTarget.anchor}
											onClose={() => setSuggestTarget(null)}
										/>
									)}
									{reviewTarget && reviewSuggestion && reviewBlock && currentPath && (
										<SuggestionReviewPopover
											path={currentPath}
											suggestion={reviewSuggestion}
											overlapSuggestions={overlapSuggestions}
											currentMarkdown={reviewBlock.markdown}
											baseRevision={snapshotRevision}
											anchor={reviewTarget.anchor}
											onClose={() => setReviewTarget(null)}
											onNavigate={(suggestionId) => openSuggestionReview(suggestionId)}
											onSettled={() => {
												setReviewTarget(null);
												void useProofStore.getState().loadSidecar(currentPath);
												void useProofStore.getState().loadSnapshot(currentPath);
											}}
										/>
									)}
									{isViewing && Object.keys(parsedViewingContent.data).length > 0 && (
										<div className="max-w-[var(--editor-max-w,48rem)] ml-[var(--editor-ml,auto)] mr-auto px-4 sm:px-8 pt-3">
											<FrontmatterHeader
												data={parsedViewingContent.data as Record<string, never>}
											/>
										</div>
									)}
									<EditorContent editor={editor} />
									{currentPath && /\.(md|markdown)$/i.test(currentPath) && (
										<BacklinksPanel currentPath={currentPath} />
									)}
									{!isViewing && (
										<>
											<EditorBubbleMenu
												editor={editor}
												onSuggestEdit={openSuggestForSelection}
												onComment={openCommentForSelection}
											/>
											<TableMenu editor={editor} />
											<SlashCommands editor={editor} />
											<WikiLinkPicker
												editor={editor}
												onCreateRequest={openWikiCreateRef.current}
											/>
										</>
									)}
									{isViewing && (
										<ViewModeCommentButton
											containerRef={scrollContainerRef}
											onComment={openCommentForSelection}
											onSuggest={openSuggestForSelection}
										/>
									)}
									{/* AI Edit Prompt + slash hint */}
									<div className="max-w-[var(--editor-max-w,48rem)] ml-[var(--editor-ml,auto)] mr-auto px-8 pb-8 flex items-center gap-4">
										<button
											onClick={handleOpenAI}
											className="group flex items-center gap-2 text-[13px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
										>
											<Sparkles className="h-3.5 w-3.5 group-hover:text-primary transition-colors" />
											<span>Edit with AI</span>
										</button>
										{!isViewing && (
											<span className="text-[11px] text-muted-foreground/30 select-none">
												<kbd className="rounded px-1 py-0.5 font-mono text-[10px] ring-1 ring-foreground/10">
													/
												</kbd>{" "}
												for commands
											</span>
										)}
									</div>
								</div>
								</div>

								{/* Google-Docs-style comment margin. Sits OUTSIDE the scroll
								    container so cards stay put while the document scrolls
								    under them; the collapse control lets it get out of the
								    way on narrow screens. */}
								{showCommentMargin && (
									<CommentMargin
										path={currentPath ?? ""}
										threads={marginThreads}
										blockOffsets={marginOffsets}
										activeRef={threadTarget?.blockRef ?? null}
										onActivate={(blockRef) => {
											const el = scrollContainerRef.current?.querySelector(
												`[data-block-ref="${CSS.escape(blockRef)}"]`,
											) as HTMLElement | null;
											setThreadTarget({ blockRef, el: el ?? document.body });
										}}
										onClose={() => setThreadTarget(null)}
										onHoverChange={(blockRef, hovered) =>
											setHoveredMarginRef(hovered ? blockRef : null)
										}
									/>
								)}

								{showLoadingOverlay && (
									<div
										className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-md z-20 pointer-events-none"
										aria-hidden="true"
									>
										<Loader2 className="h-5 w-5 animate-spin text-muted-foreground/70" />
									</div>
								)}
							</div>
						)}

						<CopyAsPrompt
							path={currentPath ?? ""}
							comments={promptComments}
							suggestions={pendingSuggestions}
							resolveSnippet={resolvePromptSnippet}
							suggestionCount={pendingSuggestions.length}
							onReviewSuggestions={() => openSuggestionReview(pendingSuggestions[0]?.id ?? "", undefined, true)}
						/>

						{/* Annotation bar — save hint and save status are edit-mode-only. */}
						<div className="flex items-center justify-between px-4 py-1 border-t border-border text-xs text-muted-foreground/60">
							{!isViewing && (
							<span className="text-[10.5px] text-muted-foreground/30 select-none hidden sm:block">
								<kbd className="rounded px-1 font-mono text-[9.5px] ring-1 ring-foreground/10">
									⌘S
								</kbd>{" "}
								save
								<span className="mx-1.5 opacity-40">·</span>
								<kbd className="rounded px-1 font-mono text-[9.5px] ring-1 ring-foreground/10">
									/
								</kbd>{" "}
								commands
							</span>
							)}
							<div className="flex items-center gap-3">
								{!isViewing && (
								<span
									className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] transition-all duration-300 ${
										saveStatus === "idle"
											? "opacity-0 pointer-events-none"
											: "opacity-100"
									} ${
										saveStatus === "saving"
											? "bg-muted text-muted-foreground"
											: saveStatus === "saved"
												? "bg-success/10 text-success"
												: saveStatus === "error"
													? "bg-destructive/10 text-destructive"
													: ""
									}`}
								>
									{saveStatus === "saving" && (
										<><Loader2 className="h-2.5 w-2.5 animate-spin" />Saving…</>
									)}
									{saveStatus === "saved" && (
										<><Check className="h-2.5 w-2.5" />Saved</>
									)}
									{saveStatus === "error" && (
										<><AlertCircle className="h-2.5 w-2.5" />Save failed</>
									)}
								</span>
							)}
							</div>
						</div>
		</div>
		{WikiCreateDialog}
	</>
	);
}
