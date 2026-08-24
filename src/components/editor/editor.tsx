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
import { wsFetch, withWs } from "@/lib/workspace-client";
import { showError } from "@/lib/toast";
import { EditorBubbleMenu } from "./bubble-menu";
import { EditorToolbar } from "./editor-toolbar";
import { editorExtensions } from "./extensions";
import { resolveWikiLink } from "./link-navigation";
import { useDocumentPresence } from "./hooks/use-document-presence";
import { useDocumentWatch } from "./hooks/use-document-watch";
import { useSuggestionCapture } from "./hooks/use-suggestion-capture";
import { CommentPip } from "./comment-pip";
import { CommentThread } from "./comment-thread";
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

type KBEditorMode = "viewing" | "editing" | "suggesting";

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
		editMode,
		setEditMode,
	} = useEditorStore();
	const effectiveMode = mode ?? editMode;
	const isViewing = effectiveMode === "viewing";
	const isSuggesting = effectiveMode === "suggesting";
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
		() => suggestionsRaw?.filter((sg) => sg.status === "pending") ?? [],
		[suggestionsRaw],
	);
	const [reviewTarget, setReviewTarget] = useState<{
		suggestionId: string;
		anchor: { top: number; left: number };
	} | null>(null);
	const suggestionDecoratorRef = useRef<SuggestionDecoratorController | null>(null);
	if (!suggestionDecoratorRef.current) {
		suggestionDecoratorRef.current = createSuggestionDecoratorPlugin(
			{ suggestions: [], blocks: [] },
			(suggestionId, element) => {
				const rect = element.getBoundingClientRect();
				setReviewTarget({
					suggestionId,
					anchor: { top: rect.bottom, left: rect.left },
				});
			},
		);
	}
	const suggestionBlocks = useMemo(
		() => snapshotBlocks.slice(snapshotBlockOffset),
		[snapshotBlockOffset, snapshotBlocks],
	);

	/**
	 * Resolve a block `ref` to a short human-readable snippet (the block's
	 * leading words) for the Copy-as-prompt surface, so prompts read
	 * `The rendering pipeline…` instead of the opaque ref id.
	 */
	const promptComments = useMemo(
		() => comments.filter((c) => c.kind !== "instruction"),
		[comments],
	);
	const resolvePromptSnippet = useMemo(() => {
		const byRef = new Map(snapshotBlocks.map((b) => [b.ref, b.markdown]));
		const shorten = (md: string) => {
			const text = md
				.replace(/^[#>\s]*/, "")
				.replace(/^[-*+]\s+/, "")
				.replace(/^\d+\.\s+/, "")
				.replace(/[*_`#>]/g, "")
				.replace(/\s+/g, " ")
				.trim();
			return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
		};
		return (annotation: { ref?: string }) => {
			const md = annotation.ref ? byRef.get(annotation.ref) : undefined;
			const snip = md ? shorten(md) : "";
			return snip || undefined;
		};
	}, [snapshotBlocks]);

	/** Group human comments by block ref for pip rendering (excludes instructions). */
	const commentsByRef = useMemo(() => {
		const map: Record<string, typeof comments> = {};
		for (const c of comments) {
			if (!c.ref || c.kind === "instruction") continue;
			(map[c.ref] ??= []).push(c);
		}
		return map;
	}, [comments]);


	/** Tracks which block's comment thread is open and its anchor element. */
	const [threadTarget, setThreadTarget] = useState<
		{ blockRef: string; el: HTMLElement } | null
	>(null);

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
		setThreadTarget({ blockRef: resolved.blockRef, el: resolved.blockEl });
	}, [resolveSelectionBlock]);


	// Suggesting-mode dirty block tracking, flush, and snapshot refresh.
	const { markDirty, flush: flushSuggestions, onSelectionUpdate } =
		useSuggestionCapture({
			path: currentPath,
			editorRef,
			scrollContainerRef,
			isLoadingRef,
			isViewingRef,
		});

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
		const containerRect = container.getBoundingClientRect();
		const next = new Map<string, { top: number; left: number; width: number; bottom: number }>();
		for (let i = 0; i < Math.min(children.length, snapshotBlocks.length - snapshotBlockOffset); i++) {
			const el = children[i];
			const block = snapshotBlocks[i + snapshotBlockOffset];
			// Annotate DOM element — Phase D comment-pip and other consumers read this
			el.setAttribute("data-block-ref", block.ref);
			const rect = el.getBoundingClientRect();
			next.set(block.ref, {
				top: rect.top - containerRect.top + container.scrollTop,
				left: rect.left - containerRect.left,
				width: rect.width,
				bottom: rect.bottom - containerRect.top + container.scrollTop,
			});
		}
		setBlockRefPositions(next);
	}, [currentPath, snapshotBlockOffset, snapshotBlocks]);

	const handleUpdate = useCallback(
		({ editor }: { editor: ReturnType<typeof useEditor> }) => {
			if (isLoadingRef.current || isViewingRef.current || !editor) return;
			// In suggesting mode, mark the edit dirty so the next block-change or
			// blur flushes it into suggestions. Still push content to the store so
			// the store guard (no autosave in suggesting mode) keeps it in sync.
			markDirty();
			const html = editor.getHTML();
			const md = htmlToMarkdown(
				html,
				useEditorStore.getState().currentPath ?? undefined,
			);
			useEditorStore.getState().updateContent(md);
		},
		[],
	);

	const editor = useEditor({
		extensions: editorExtensions,
		content: "",
		editable: !isViewing,
		onUpdate: handleUpdate,
		onBlur: () => {
			void flushSuggestions();
		},
		onSelectionUpdate: ({ editor: ed }) => {
			onSelectionUpdate(ed);
		},
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
	const [renderedPath, setRenderedPath] = useState<string | null>(null);
	useEffect(() => {
		if (!editor || currentPath === null) return;
		// Skip if content hasn't actually changed (same path, dirty edit)
		if (
			useEditorStore.getState().isDirty &&
			currentPath === prevPathRef.current
		)
			return;
		// During page navigation the store briefly holds content="" while the
		// fetch is in flight. Rendering that empty string into ProseMirror is
		// pure waste — every extension runs a full schema pass twice per
		// navigation. Skip until the real content arrives.
		if (isLoading && content === "") return;
		// Dedupe identical (path, content) renders — e.g. cached paint followed
		// by a fresh fetch that returned the same markdown.
		const renderMarkdown = parsedViewingContent.body;
		const key = `${currentPath} ${renderMarkdown}`;
		if (renderedKeyRef.current === key) {
			if (renderedPath !== currentPath) setRenderedPath(currentPath);
			return;
		}
		prevPathRef.current = currentPath;

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
			setRenderedPath(currentPath);
			setTimeout(() => {
				isLoadingRef.current = false;
			}, 50);
		};

		setContent();
		return () => {
			cancelled = true;
		};
	}, [editor, content, currentPath, isLoading, renderedPath, parsedViewingContent.body, isViewing]);

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
							<div className="flex-1 relative" dir={isRtl ? "rtl" : undefined}>
								{isSuggesting && (
									<div className="absolute top-0 inset-x-0 z-20 flex items-center justify-center gap-2 px-3 py-1 bg-primary/10 border-b border-primary/20 text-[11px] text-primary pointer-events-none">
										Suggesting mode · your edits become suggestions for review
									</div>
								)}
								<DocumentOutline editor={editor} scrollContainerRef={scrollContainerRef} />
								<ReadingExperiments editor={editor} scrollContainerRef={scrollContainerRef} />
								<div
									ref={scrollContainerRef}
									className={`absolute inset-0 overflow-y-auto ${
										isSuggesting ? "pt-7" : ""
								}`}
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
										{/* Comment pips — one per block with at least one comment */}
										{Object.entries(commentsByRef).map(([blockRef, blockComments]) => {
											const pos = blockRefPositions.get(blockRef);
											if (!pos) return null;
											return (
												<div key={`pip-${blockRef}`} style={{ pointerEvents: "auto" }}>
							<CommentPip
								anchorKey={blockRef}
								anchorLabel={blockRef}
								comments={blockComments}
								top={pos.top + 4}
								left={Math.max(0, pos.left - 20)}
								onClick={() => {
									const el = scrollContainerRef.current?.querySelector(
										`[data-block-ref="${blockRef}"]`,
									) as HTMLElement | null;
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
							comments={
								(commentsByRef[threadTarget.blockRef]) ?? []
							}
							anchorEl={threadTarget.el}
							onClose={() => setThreadTarget(null)}
							readOnly={isViewing}
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
											currentMarkdown={reviewBlock.markdown}
											baseRevision={snapshotRevision}
											anchor={reviewTarget.anchor}
											onClose={() => setReviewTarget(null)}
											onSettled={() => {
												setReviewTarget(null);
												void useProofStore.getState().loadSidecar(currentPath);
												void useProofStore.getState().loadSnapshot(currentPath);
											}}
											readOnly={isViewing}
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

						{!isViewing && (
						/* Status bar */
						<div className="flex items-center justify-between px-4 py-1 border-t border-border text-xs text-muted-foreground/60">
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
							<div className="flex items-center gap-3">
								<CopyAsPrompt
									path={currentPath ?? ""}
									comments={promptComments}
									suggestions={pendingSuggestions}
									resolveSnippet={resolvePromptSnippet}
								/>
								{/* Mode toggle */}
								<div
									className="flex items-center rounded-md border border-border overflow-hidden text-[10.5px]"
									role="radiogroup"
									aria-label="Edit mode"
								>
									<button
										type="button"
										role="radio"
										aria-checked={editMode === "editing"}
										onClick={() => setEditMode("editing")}
										className={`px-2 py-0.5 transition-colors ${
											editMode === "editing"
												? "bg-primary text-primary-foreground"
												: "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										}`}
									>
										Editing
									</button>
									<button
										type="button"
										role="radio"
										aria-checked={editMode === "suggesting"}
										onClick={() => setEditMode("suggesting")}
										className={`px-2 py-0.5 transition-colors ${
											editMode === "suggesting"
												? "bg-primary text-primary-foreground"
												: "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
										}`}
									>
										Suggesting
									</button>
								</div>
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
							</div>
						</div>
						)}
		</div>
		{WikiCreateDialog}
	</>
	);
}
