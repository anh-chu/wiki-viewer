"use client";

import { cellAround, isInTable } from "@tiptap/pm/tables";
import { EditorContent, useEditor } from "@tiptap/react";
import { Code2, FilePlus, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { findNodeByPath } from "@/lib/cabinets/tree";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useEditorStore } from "@/stores/editor-store";
import { useTreeStore } from "@/stores/tree-store";
import { useViewWidthStore, VIEW_WIDTH_CSS } from "@/stores/view-width-store";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import type { TreeNode } from "@/types";
import { useProofStore } from "@/stores/proof-store";
import { captureSuggestion } from "@/lib/proof/suggest-capture";
import { EditorBubbleMenu } from "./bubble-menu";
import { EditorToolbar } from "./editor-toolbar";
import { editorExtensions } from "./extensions";
import { FolderIndex } from "./folder-index";
import { CommentPip } from "./comment-pip";
import { CommentThread } from "./comment-thread";
import { ProofSpanPopover } from "./proof-span-popover";
import { SuggestionCard } from "./suggestion-card";
import { SuggestEditPopover } from "./suggest-edit-popover";
import { SlashCommands } from "./slash-commands";
import { TableMenu } from "./table-menu";
import {
	useWikiLinkCreate,
	type WikiCreateResult,
} from "./wiki-link-create-dialog";
import { WikiLinkPicker } from "./wiki-link-picker";

async function uploadFile(
	pagePath: string,
	file: File,
): Promise<string | null> {
	const formData = new FormData();
	formData.append("file", file);
	try {
		const res = await fetch(`/api/upload/${pagePath}`, {
			method: "POST",
			body: formData,
		});
		if (!res.ok) return null;
		const data = await res.json();
		return data.url;
	} catch {
		return null;
	}
}

function flattenTree(nodes: TreeNode[]): { path: string; name: string }[] {
	const result: { path: string; name: string }[] = [];
	for (const node of nodes) {
		result.push({ path: node.path, name: node.name });
		if (node.children) result.push(...flattenTree(node.children));
	}
	return result;
}

function findPageBySlug(
	slug: string,
	currentPath: string | null,
	nodes: TreeNode[],
): string | null {
	const allPages = flattenTree(nodes);
	// The slug matches the last segment of the path
	const matches = allPages.filter(
		(p) => p.name === slug || p.path.endsWith(`/${slug}`),
	);
	if (matches.length === 0) return null;
	if (matches.length === 1) return matches[0].path;

	// Prefer sibling pages (same parent directory as current page)
	if (currentPath) {
		const parentDir = currentPath.includes("/")
			? currentPath.substring(0, currentPath.lastIndexOf("/"))
			: "";
		const sibling = matches.find(
			(m) => m.path === (parentDir ? `${parentDir}/${slug}` : slug),
		);
		if (sibling) return sibling.path;
	}
	return matches[0].path;
}

function navigateToPage(
	targetPath: string,
	selectPage: (path: string) => void,
	expandPath: (path: string) => void,
) {
	const parts = targetPath.split("/");
	for (let i = 1; i < parts.length; i++) {
		expandPath(parts.slice(0, i).join("/"));
	}
	selectPage(targetPath);
	useEditorStore.getState().loadPage(targetPath);
	// Scroll editor container to top
	setTimeout(() => {
		document.querySelector("[data-editor-scroll]")?.scrollTo(0, 0);
	}, 0);
}

function resolveInternalLink(
	href: string,
	currentPath: string | null,
	nodes: TreeNode[],
): string | null {
	const allPages = flattenTree(nodes);

	// Clean up the href: strip .md extension, leading ./ or /
	const linkPath = href
		.replace(/\.md$/, "")
		.replace(/^\.\//, "")
		.replace(/^\//, "");

	// 1. Try as absolute path (exact match in tree)
	const exactMatch = allPages.find((p) => p.path === linkPath);
	if (exactMatch) return exactMatch.path;

	// 2. Try relative to current page's directory
	if (currentPath) {
		const parentDir = currentPath.includes("/")
			? currentPath.substring(0, currentPath.lastIndexOf("/"))
			: "";
		const relativePath = parentDir ? `${parentDir}/${linkPath}` : linkPath;
		const relMatch = allPages.find((p) => p.path === relativePath);
		if (relMatch) return relMatch.path;
	}

	// 3. Try matching by last segment (slug-style lookup)
	const slug = linkPath.includes("/") ? linkPath.split("/").pop()! : linkPath;
	return findPageBySlug(slug, currentPath, nodes);
}

export function KBEditor() {
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
	const nodes = useTreeStore((s) => s.nodes);
	const editorMaxW = useViewWidthStore((s) => VIEW_WIDTH_CSS[s.width]);
	const isRtl = frontmatter?.dir === "rtl";
	const { open: openAI, clearMessages } = useAIPanelStore();
	const { open: openWikiCreate, Dialog: WikiCreateDialog } =
		useWikiLinkCreate();
	// Keep a stable ref so the click handler closure can call the latest version
	// without being re-created on every render.
	const openWikiCreateRef =
		useRef<(slug: string) => Promise<WikiCreateResult>>(openWikiCreate);
	openWikiCreateRef.current = openWikiCreate;

	const isLoadingRef = useRef(false);
	const [sourceMode, setSourceMode] = useState(false);
	const [sourceText, setSourceText] = useState("");
	// Reset the tab to "page" whenever the path changes — opening a new folder
	// shouldn't skip its index.md if the previous folder was on Files. Has to
	// be an effect (not state-during-render) because Tiptap's EditorContent
	// calls flushSync internally; setState during the parent render explodes
	// when EditorContent renders in the same pass.
	const [folderTab, setFolderTab] = useState<"page" | "files">("page");
	useEffect(() => {
		setFolderTab("page");
	}, []);

	// Prime the slug index once on mount so wiki-link broken-state and
	// the autocomplete picker both have data immediately.
	useEffect(() => {
		void useWikiSlugsStore.getState().load();
	}, []);

	// Load sidecar when the current path changes.
	useEffect(() => {
		if (!currentPath) return;
		void useProofStore.getState().loadSidecar(currentPath);
	}, [currentPath]);

	// Subscribe to chokidar SSE: when current file changes on disk, reload sidecar.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const es = new EventSource("/api/wiki/watch");
		es.onmessage = (evt: MessageEvent<string>) => {
			try {
				const data = JSON.parse(evt.data) as { type: string; path: string };
				const activePath = useEditorStore.getState().currentPath;
				if (
					(data.type === "change" || data.type === "add") &&
					activePath &&
					data.path === activePath
				) {
					// loadSnapshot first so server-side readSnapshot detects
					// fingerprint mismatch, emits file.externallyEdited, and persists
					// the sidecar. Then loadSidecar to refresh comments/suggestions.
					void useProofStore
						.getState()
						.loadSnapshot(activePath)
						.then(() => useProofStore.getState().loadSidecar(activePath));
				}
			} catch {
				// ignore malformed events
			}
		};
		return () => {
			es.close();
		};
	}, []);

	// Proof-span popover state.
	const [proofTarget, setProofTarget] = useState<HTMLElement | null>(null);

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
	const comments = useMemo(() => commentsRaw ?? [], [commentsRaw]);
	const pendingSuggestions = useMemo(
		() => suggestionsRaw?.filter((sg) => sg.status === "pending") ?? [],
		[suggestionsRaw],
	);

	/** Group comments by block ref for pip rendering. */
	const commentsByRef = useMemo(() => {
		const map: Record<string, typeof comments> = {};
		for (const c of comments) {
			(map[c.ref] ??= []).push(c);
		}
		return map;
	}, [comments]);

	/** Tracks which block's comment thread is open and its anchor element. */
	const [threadTarget, setThreadTarget] = useState<{ blockRef: string; el: HTMLElement } | null>(null);

	/** Tracks the open human "suggest edit" popover (block + anchor + content). */
	const [suggestTarget, setSuggestTarget] = useState<
		{ blockRef: string; markdown: string; anchor: { top: number; left: number } } | null
	>(null);

	/**
	 * Resolve the current editor selection to a top-level block.
	 *
	 * Primary strategy: map the selection to its top-level ProseMirror child
	 * INDEX, then look up snapshotBlocks[index] — the same index-based mapping
	 * used by the position-tracker effect. This is robust even when the DOM
	 * `data-block-ref` annotation has not been applied yet (e.g. snapshot still
	 * loading), which previously made the suggest/comment buttons silently
	 * no-op. Falls back to walking the DOM for an existing [data-block-ref].
	 */
	const resolveSelectionBlock = useCallback((): {
		blockRef: string;
		blockEl: HTMLElement;
		markdown: string;
	} | null => {
		if (!editorRef.current) return null;
		const view = editorRef.current.view;
		const { from } = view.state.selection;
		const path = useEditorStore.getState().currentPath ?? "";
		const blocks = useProofStore.getState().byPath[path]?.snapshotBlocks ?? [];

		// Find the top-level child index containing the selection head.
		const $pos = view.state.doc.resolve(from);
		const topIndex = $pos.depth > 0 ? $pos.index(0) : 0;

		const proseMirror = scrollContainerRef.current?.querySelector(".ProseMirror");
		const children = proseMirror
			? (Array.from(proseMirror.children) as HTMLElement[])
			: [];
		const blockEl = children[topIndex] ?? null;

		// Prefer the index-aligned snapshot block; fall back to the DOM attr.
		const block = blocks[topIndex];
		let blockRef: string | null =
			block?.ref ?? blockEl?.getAttribute("data-block-ref") ?? null;
		const markdown = block?.markdown ?? "";

		if (!blockRef && blockEl) {
			// Last-resort: DOM walk from selection anchor.
			const domAt = view.domAtPos(from);
			const node: HTMLElement | null =
				domAt.node.nodeType === Node.ELEMENT_NODE
					? (domAt.node as HTMLElement)
					: domAt.node.parentElement;
			const found = node?.closest<HTMLElement>("[data-block-ref]") ?? null;
			blockRef = found?.getAttribute("data-block-ref") ?? null;
		}

		if (!blockRef || !blockEl) return null;
		return { blockRef, blockEl, markdown };
	}, []);

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

	// ── Suggesting mode: capture human block edits as suggestions ──────────────
	//
	// In suggesting mode the editor stays editable but edits never touch the
	// file. On flush (leaving a block or blurring the editor) we diff each
	// top-level block against the snapshot, emit a human `suggestion.add` for
	// every changed/added/removed block, then revert the editor to the snapshot
	// so the pending suggestion cards render over the original content.

	/** Set true whenever the user edits while in suggesting mode. */
	const suggestDirtyRef = useRef(false);
	/** Guards against re-entrant flushes (capture is async). */
	const flushingRef = useRef(false);
	/** Top-level block index that currently holds the selection. */
	const activeBlockIndexRef = useRef<number | null>(null);

	const normalizeMd = (s: string): string => s.replace(/\s+$/g, "").trimStart();

	const flushSuggestions = useCallback(async () => {
		if (flushingRef.current) return;
		if (useEditorStore.getState().editMode !== "suggesting") return;
		if (!suggestDirtyRef.current) return;
		const ed = editorRef.current;
		const path = useEditorStore.getState().currentPath;
		if (!ed || !path) return;

		const proseMirror = scrollContainerRef.current?.querySelector(".ProseMirror");
		if (!proseMirror) return;
		const children = Array.from(proseMirror.children) as HTMLElement[];
		const snapBlocks =
			useProofStore.getState().byPath[path]?.snapshotBlocks ?? [];
		if (snapBlocks.length === 0) return;

		flushingRef.current = true;
		suggestDirtyRef.current = false;
		try {
			const getRevision = () =>
				useProofStore.getState().byPath[path]?.snapshotRevision ?? 0;
			const refresh = async () => {
				await useProofStore.getState().loadSnapshot(path);
				await useProofStore.getState().loadSidecar(path);
			};

			const count = Math.max(children.length, snapBlocks.length);
			let captured = false;
			for (let i = 0; i < count; i++) {
				const el = children[i];
				const snap = snapBlocks[i];
				const curMd = el ? htmlToMarkdown(el.outerHTML).trim() : null;

				if (snap && curMd !== null) {
					if (normalizeMd(curMd) !== normalizeMd(snap.markdown)) {
						const ok = await captureSuggestion({
							path,
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
						path,
						ref: snap.ref,
						kind: "delete",
						getRevision,
						refresh,
					});
					captured = captured || ok;
				} else if (!snap && curMd !== null && curMd.length > 0) {
					// New trailing block: suggest inserting after the last known block.
					const lastRef = snapBlocks[snapBlocks.length - 1]?.ref;
					if (lastRef) {
						const ok = await captureSuggestion({
							path,
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
				// Reload sidecar so the new pending suggestion cards appear, then
				// revert the editor to the snapshot (file unchanged).
				await refresh();
				const freshSnap =
					useProofStore.getState().byPath[path]?.snapshotBlocks ?? snapBlocks;
				const snapshotMarkdown = freshSnap.map((b) => b.markdown).join("\n\n");
				isLoadingRef.current = true;
				const html = await markdownToHtml(snapshotMarkdown, path);
				ed.commands.setContent(html);
				setTimeout(() => {
					isLoadingRef.current = false;
				}, 50);
			}
		} finally {
			flushingRef.current = false;
		}
	}, []);

	// Load snapshot (ordered block list) when path changes so suggestion cards
	// can look up block content by ref.
	useEffect(() => {
		if (!currentPath) return;
		void useProofStore.getState().loadSnapshot(currentPath);
	}, [currentPath]);

	/**
	 * After content renders, walk `.ProseMirror > *` to build ref→position map.
	 * Matches by index: the i-th ProseMirror child = snapshotBlocks[i].
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
		for (let i = 0; i < Math.min(children.length, snapshotBlocks.length); i++) {
			const el = children[i];
			const block = snapshotBlocks[i];
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
	}, [currentPath, snapshotBlocks]);

	const handleUpdate = useCallback(
		({ editor }: { editor: ReturnType<typeof useEditor> }) => {
			if (isLoadingRef.current || !editor) return;
			// In suggesting mode, mark the edit dirty so the next block-change or
			// blur flushes it into suggestions. Still push content to the store so
			// the store guard (no autosave in suggesting mode) keeps it in sync.
			if (useEditorStore.getState().editMode === "suggesting") {
				suggestDirtyRef.current = true;
			}
			const html = editor.getHTML();
			const md = htmlToMarkdown(html);
			useEditorStore.getState().updateContent(md);
		},
		[],
	);

	const editor = useEditor({
		extensions: editorExtensions,
		content: "",
		onUpdate: handleUpdate,
		onBlur: () => {
			void flushSuggestions();
		},
		onSelectionUpdate: ({ editor: ed }) => {
			if (useEditorStore.getState().editMode !== "suggesting") return;
			const { from } = ed.state.selection;
			const $pos = ed.state.doc.resolve(from);
			const idx = $pos.depth > 0 ? $pos.index(0) : 0;
			const prev = activeBlockIndexRef.current;
			activeBlockIndexRef.current = idx;
			// Moved to a different top-level block — flush edits to the prior one.
			if (prev !== null && prev !== idx && suggestDirtyRef.current) {
				void flushSuggestions();
			}
		},
		editorProps: {
			attributes: {
				class:
					"focus:outline-none min-h-[calc(100vh-12rem)] px-4 sm:px-8 py-6 max-w-[var(--editor-max-w,48rem)] mx-auto",
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
								document
									.querySelector(`[id="${anchor}"]`)
									?.scrollIntoView({ behavior: "smooth" });
							}, 200);
						}
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

				// Wiki-links: #page:slug
				if (href.startsWith("#page:")) {
					event.preventDefault();
					event.stopPropagation();
					const slug = href.replace("#page:", "");
					const { nodes, selectPage, expandPath } = useTreeStore.getState();
					const activePath = useEditorStore.getState().currentPath;
					const targetPath = findPageBySlug(slug, activePath, nodes);
					if (targetPath) {
						navigateToPage(targetPath, selectPage, expandPath);
					}
					return true;
				}

				// Internal links: relative paths to .md files or other KB pages
				// Skip external URLs and API asset links (PDFs, images)
				if (/^https?:\/\//.test(href) || href.startsWith("/api/")) return false;
				if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;

				event.preventDefault();
				event.stopPropagation();

				const { nodes, selectPage, expandPath } = useTreeStore.getState();
				const activePath = useEditorStore.getState().currentPath;

				// Resolve the link target to a KB page path
				const targetPath = resolveInternalLink(href, activePath, nodes);
				if (targetPath) {
					navigateToPage(targetPath, selectPage, expandPath);
				}
				return true;
			},
			handlePaste: (_view, event) => {
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
	const editorRef = useRef<typeof editor>(editor);
	editorRef.current = editor;

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
		const key = `${currentPath} ${content}`;
		if (renderedKeyRef.current === key) {
			if (renderedPath !== currentPath) setRenderedPath(currentPath);
			return;
		}
		prevPathRef.current = currentPath;

		const setContent = async () => {
			isLoadingRef.current = true;
			const html = await markdownToHtml(content, currentPath);
			editor.commands.setContent(html);
			renderedKeyRef.current = key;
			setRenderedPath(currentPath);
			setTimeout(() => {
				isLoadingRef.current = false;
			}, 50);
		};

		setContent();
	}, [editor, content, currentPath, isLoading, renderedPath]);

	const showLoadingOverlay =
		currentPath !== null && (isLoading || renderedPath !== currentPath);

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
		const folderNode = findNodeByPath(nodes, currentPath);
		const folderChildren = folderNode?.children ?? [];
		const hasChildren = folderChildren.length > 0;
		return (
			<div className="flex-1 overflow-y-auto">
				<div className="max-w-3xl mx-auto px-6 py-10 space-y-6">
					<div className="space-y-3">
						<p className="text-lg font-medium tracking-[-0.02em] text-foreground">
							{inferredTitle}
						</p>
						<p className="text-sm text-muted-foreground/80">
							This folder doesn&apos;t have an{" "}
							<code className="px-1 py-0.5 rounded bg-muted text-[12px]">
								index.md
							</code>
							{hasChildren ? " yet — its contents are listed below." : " yet."}
						</p>
						<button
							onClick={() => void createMissingPage(inferredTitle)}
							className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
						>
							<FilePlus className="h-3.5 w-3.5" />
							Create page
						</button>
					</div>
					{hasChildren && (
						<FolderIndex
							key={currentPath}
							folderPath={currentPath}
							entries={folderChildren}
						/>
					)}
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
				setTimeout(() => {
					isLoadingRef.current = false;
				}, 50);
			}
			setSourceMode(false);
		}
	};

	// Folder pages with both an index.md (loadStatus === "ok") AND children
	// get a Page / Files tab strip so users can switch between the page body
	// and the directory listing without leaving the route.
	const renderedFolderNode = findNodeByPath(nodes, currentPath);
	const renderedFolderChildren =
		renderedFolderNode?.type === "directory" ||
		renderedFolderNode?.type === "cabinet"
			? (renderedFolderNode.children ?? [])
			: [];
	const showFolderTabs = renderedFolderChildren.length > 0;
	const onFilesTab = showFolderTabs && folderTab === "files";

	return (
		<>
			<div className="flex-1 flex flex-col overflow-hidden">
				{showFolderTabs && (
					<div className="flex items-center gap-1 px-3 pt-2 border-b border-border">
						<button
							onClick={() => setFolderTab("page")}
							className={`px-3 py-1.5 text-[12px] rounded-t-md border-b-2 -mb-px transition-colors ${
								folderTab === "page"
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
							aria-pressed={folderTab === "page"}
						>
							Page
						</button>
						<button
							onClick={() => setFolderTab("files")}
							className={`px-3 py-1.5 text-[12px] rounded-t-md border-b-2 -mb-px transition-colors ${
								folderTab === "files"
									? "border-primary text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
							aria-pressed={folderTab === "files"}
						>
							Files
							<span className="ml-1.5 text-muted-foreground/60">
								{renderedFolderChildren.length}
							</span>
						</button>
					</div>
				)}
				{onFilesTab ? (
					<div className="flex-1 overflow-y-auto">
						<div className="max-w-3xl mx-auto px-6 py-6">
							<FolderIndex
								key={currentPath}
								folderPath={currentPath}
								entries={renderedFolderChildren}
							/>
						</div>
					</div>
				) : (
					<>
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
								{editMode === "suggesting" && (
									<div className="absolute top-0 inset-x-0 z-20 flex items-center justify-center gap-2 px-3 py-1 bg-primary/10 border-b border-primary/20 text-[11px] text-primary pointer-events-none">
										Suggesting mode · your edits become suggestions for review
									</div>
								)}
								<div
									ref={scrollContainerRef}
									className={`absolute inset-0 overflow-y-auto ${
										editMode === "suggesting" ? "pt-7" : ""
								}`}
									style={{ ["--editor-max-w" as string]: editorMaxW }}
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
														blockRef={blockRef}
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

										{/* Suggestion cards — one per pending suggestion */}
										{currentPath && pendingSuggestions.map((sg) => {
											const pos = blockRefPositions.get(sg.ref);
											const currentBlock = snapshotBlocks.find((b) => b.ref === sg.ref);
											if (!pos || !currentBlock) return null;
											const cardTop =
												sg.kind === "insertAfter" ? pos.bottom + 4 :
												sg.kind === "insertBefore" ? Math.max(0, pos.top - 80) :
												pos.top;
											return (
												<div key={`sug-${sg.id}`} style={{ pointerEvents: "auto" }}>
													<SuggestionCard
														path={currentPath}
														suggestion={sg}
														currentMarkdown={currentBlock.markdown}
														baseRevision={snapshotRevision}
														getLatestRevision={() =>
															useProofStore.getState().byPath[currentPath]?.snapshotRevision ?? 0
														}
														top={cardTop}
														left={pos.left}
														width={pos.width}
														onSettled={() => {
															void useProofStore.getState().loadSidecar(currentPath);
															void useProofStore.getState().loadSnapshot(currentPath);
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
											blockRef={threadTarget.blockRef}
											comments={commentsByRef[threadTarget.blockRef] ?? []}
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

									<EditorContent editor={editor} />
									{/* Proof-span hover delegation */}
									<div
										aria-hidden="true"
										className="contents"
										onMouseOver={(e) => {
											const span = (e.target as HTMLElement).closest<HTMLElement>(".proof-span");
											if (span && span !== proofTarget) setProofTarget(span);
										}}
										onMouseOut={(e) => {
											const related = e.relatedTarget as HTMLElement | null;
											if (!related?.closest(".proof-span")) setProofTarget(null);
										}}
									/>
									{currentPath && (
										<ProofSpanPopover
											targetEl={proofTarget}
											path={currentPath}
											onClose={() => setProofTarget(null)}
											onComment={() => {
												if (!proofTarget) return;
												const blockEl = proofTarget.closest<HTMLElement>("[data-block-ref]");
												if (!blockEl) return;
												const blockRef = blockEl.getAttribute("data-block-ref");
												if (blockRef) setThreadTarget({ blockRef, el: blockEl });
											}}
										/>
									)}
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

									{/* AI Edit Prompt + slash hint */}
									<div className="max-w-[var(--editor-max-w,48rem)] mx-auto px-8 pb-8 flex items-center gap-4">
										<button
											onClick={handleOpenAI}
											className="group flex items-center gap-2 text-[13px] text-muted-foreground/50 hover:text-muted-foreground transition-colors cursor-pointer"
										>
											<Sparkles className="h-3.5 w-3.5 group-hover:text-primary transition-colors" />
											<span>Edit with AI</span>
										</button>
										<span className="text-[11px] text-muted-foreground/30 select-none">
											<kbd className="rounded px-1 py-0.5 font-mono text-[10px] ring-1 ring-foreground/10">
												/
											</kbd>{" "}
											for commands
										</span>
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

						{/* Status bar */}
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
												: "text-muted-foreground hover:bg-accent"
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
												: "text-muted-foreground hover:bg-accent"
										}`}
									>
										Suggesting
									</button>
								</div>
								<span>
									{saveStatus === "saving" && "Saving..."}
									{saveStatus === "saved" && "Saved"}
									{saveStatus === "error" && "Save failed"}
								</span>
							</div>
						</div>
					</>
				)}
			</div>
			{WikiCreateDialog}
		</>
	);
}
