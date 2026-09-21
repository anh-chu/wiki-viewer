"use client";

import { cellAround, isInTable } from "@tiptap/pm/tables";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { AlertCircle, Check, Code2, FilePlus, Loader2, MessageSquare, PenLine, PencilLine, Sparkles } from "lucide-react";
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
import type { MarkId } from "@/lib/proof/suggestion-mark";
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
import { CommentThread } from "./comment-thread";
import { COMMENT_COLUMN_WIDTH_CSS, CommentMargin } from "./comment-margin";
import { postOp } from "@/lib/proof/post-op";
import {
	MODULE_MAP_LIMIT,
	remember,
	shouldRestoreDraft,
	type SourceDraft,
} from "./editor-module-state";
import { SlashCommands } from "./slash-commands";
import { AnnotationsButton } from "./annotations-button";
import {
	panelContents,
	useAnnotationPanelStore,
} from "@/stores/annotation-panel-store";
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
	type BlockPosition,
} from "@/lib/proof/pip-alignment";
import { shouldRerenderDocument } from "@/lib/proof/render-guard";
import { commentHighlightExtension, refreshCommentHighlights } from "./extensions/comment-highlight";
import {
	applySuggestion,
	applySuggestions,
	disableSuggestChanges,
	enableSuggestChanges,
	isSuggestChangesEnabled,
	revertSuggestion,
	revertSuggestions,
} from "@/vendor/prosemirror-suggest-changes/index.js";

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

/**
 * Module-scope editor state, keyed by document path.
 *
 * These maps exist because the editor is REMOUNTED on external file changes, which
 * resets component state and refs alike. Keying by path keeps each value with the
 * document it belongs to; a single global value would carry it across documents.
 * The specific damage each one prevents is noted at its declaration.
 */

/**
 * Source mode and its unsaved draft.
 *
 * Source mode is a plain <textarea> holding the file's markdown, so a remount would
 * reset both `sourceText` (to "") and `sourceMode` (to false) — silently discarding
 * whatever was typed and dropping the reader back into the rendered view, with no
 * warning and no undo. Switching back to Source would reload the store's older content
 * rather than the draft.
 */
const sourceDraftByPath = new Map<string, SourceDraft>();
const sourceModeByPath = new Map<string, boolean>();

/**
 * Whether Suggesting mode is on.
 *
 * Losing the margin expansion to a remount is cosmetic; losing this one means edits
 * stop being tracked without the reader being told.
 */
const suggestingModeByPath = new Map<string, boolean>();

/**
 * Expanded margin card per document path.
 *
 * Module scope so it outlives the editor remount described at `activeMarginRef`.
 * The map is small (one entry per visited document) and entries are cleared when a
 * card collapses, so it cannot grow without bound.
 */
const expandedMarginByPath = new Map<string, string>();

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
	// The outline column is owned HERE, not inside DocumentOutline, so that opening
	// or closing it can feed the reflow key: a reflow in either direction moves the
	// annotation cards in exactly the way opening the comment panel does.
	const [outlineOpen, setOutlineOpen] = useState(() => {
		try {
			return typeof window !== "undefined" && localStorage.getItem("kb-outline-pinned") !== "0";
		} catch {
			return true;
		}
	});
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
	const [sourceMode, setSourceMode] = useState(
		() => sourceModeByPath.get(currentPath ?? "") ?? false,
	);
	/**
	 * Editing vs Suggesting, the Docs mode pair.
	 *
	 * Held in React state for rendering AND mirrored into editor storage, because the
	 * transaction filter reads it synchronously — React state would report the previous
	 * value inside a transaction firing in the same tick as the click.
	 *
	 * The module-scope copy matters more than the margin expansion's: on remount
	 * `suggesting` reset to false while the stale ProseMirror storage went with it, so a
	 * reader who had switched to Suggesting was silently back in Editing and their next
	 * keystroke edited the document directly instead of being tracked.
	 */
	const [suggesting, setSuggesting] = useState(
		() => suggestingModeByPath.get(currentPath ?? "") ?? false,
	);
	/**
	 * Whether any tracked change exists, so the Accept/Reject controls only appear
	 * when there is a decision to make. Recomputed from the document on every
	 * transaction rather than tracked in state, because a stale flag would hide the
	 * controls while suggestions were still pending.
	 */
	const [trackedCount, setTrackedCount] = useState(0);
	const hasTrackedChanges = trackedCount > 0;

	/**
	 * Accept or reject every TRACKED CHANGE — the marks — in the document, as one
	 * undo step.
	 *
	 * This settles marks and nothing else. It deliberately does NOT touch the
	 * sidecar's `suggestions`: those are a separate source (agent-authored
	 * proposals reviewed one at a time through the review popover), and the button
	 * that calls this only appears when `hasTrackedChanges` is true. Settling
	 * sidecar records here meant a user who saw two redlines and clicked "Accept
	 * all" also accepted every pending agent proposal they had never opened.
	 *
	 * The earlier coupling was real once — typed suggestions used to be sidecar
	 * records, so the marks and the records moved together and had to be settled
	 * together. Typed suggestions are now document marks with no sidecar record,
	 * so that coupling is gone and settling one from the other is just a way to
	 * write a change the user did not ask for.
	 */
	/**
	 * Settle ONE suggested change, identified by its mark id and range.
	 *
	 * `applySuggestion` is id-scoped, which is the property that makes per-card
	 * Approve/Reject possible: the whole-document `applySuggestions`/`revertSuggestions`
	 * below would settle every other pending mark at the same time.
	 */
	const resolveOneTracked = useCallback((id: MarkId, from: number, to: number, decision: "accept" | "reject") => {
		const editor = editorRef.current;
		if (!editor) return;
		const command = decision === "accept" ? applySuggestion : revertSuggestion;
		command(id, from, to)(editor.state, editor.view.dispatch);
	}, []);

	const resolveAllTracked = useCallback((decision: "accept" | "reject") => {
		const editor = editorRef.current;
		if (!editor) return;
		// The document transform comes from the vendored library: accept removes the
		// text inside deletion marks and drops insertion marks, reject does the
		// mirror. Same command the per-suggestion control uses.
		const command =
			decision === "accept" ? applySuggestions : revertSuggestions;
		command(editor.state, editor.view.dispatch);
		setTrackedCount(0);
	}, []);

	// Adopt the new document's mode when the path changes without a remount, and keep
	// the plugin in step. Without this the state would still hold the previous
	// document's mode while the map held the new one's, so the toolbar and the stored
	// value could disagree — and the re-arm effect below would write the stale one back.
	const suggestingPathRef = useRef<string | null>(currentPath ?? null);
	useEffect(() => {
		const key = currentPath ?? "";
		if (suggestingPathRef.current === key) return;
		suggestingPathRef.current = key;
		setSuggesting(suggestingModeByPath.get(key) ?? false);
	}, [currentPath]);

	const toggleSuggestingMode = useCallback(() => {
		setSuggesting((prev) => {
			const next = !prev;
			const key = useEditorStore.getState().currentPath ?? "";
			if (next) remember(suggestingModeByPath, key, true);
			else suggestingModeByPath.delete(key);
			if (editorRef.current) {
				const { state, view } = editorRef.current;
				(next ? enableSuggestChanges : disableSuggestChanges)(state, view.dispatch);
			}
			return next;
		});
	}, []);

	const [sourceText, setSourceText] = useState(
		// Seed only from a draft whose revision still matches; the effect below re-checks
		// once the sidecar for this path has loaded.
		() => {
			const key = currentPath ?? "";
			const draft = sourceDraftByPath.get(key);
			const revision = useProofStore.getState().byPath[key]?.snapshotRevision ?? 0;
			return shouldRestoreDraft(draft, revision) ? (draft as SourceDraft).text : "";
		},
	);

	// Record Source mode and its draft on every change, not only when toggling. The
	// remount can happen mid-edit, so a write-back that runs on toggle alone would
	// still lose everything typed since. Both are keyed by path; an empty draft is
	// dropped rather than stored so the map does not accumulate empty entries.
	const sourcePathRef = useRef<string | null>(currentPath ?? null);
	useEffect(() => {
		const key = currentPath ?? "";
		if (sourcePathRef.current !== key) {
			// Path changed without a remount: adopt the new document's own state rather
			// than persisting this document's draft against the new path.
			sourcePathRef.current = key;
			setSourceMode(sourceModeByPath.get(key) ?? false);
			// Restore the draft only against the revision it was typed at. A draft from
			// an older revision would silently revert whatever changed the file since.
			const draft = sourceDraftByPath.get(key);
			const revision = useProofStore.getState().byPath[key]?.snapshotRevision ?? 0;
			setSourceText(shouldRestoreDraft(draft, revision) ? (draft as SourceDraft).text : "");
			return;
		}
		if (sourceMode) remember(sourceModeByPath, key, true);
		else sourceModeByPath.delete(key);
		if (sourceText) {
			remember(sourceDraftByPath, key, {
				text: sourceText,
				revision: useProofStore.getState().byPath[key]?.snapshotRevision ?? 0,
			});
		} else sourceDraftByPath.delete(key);
	}, [sourceMode, sourceText, currentPath]);

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
		Map<string, BlockPosition>
	>(new Map());



	// Subscribe to snapshot data for suggestion cards.
	// NOTE: select the RAW stored references here — returning a freshly built
	// array (e.g. `?? []` or `.filter(...)`) on every call makes
	// useSyncExternalStore think the snapshot changed each render, which spins
	// into a "Maximum update depth exceeded" loop. Derive defaults/filters below.
	const snapshotBlocksRaw = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.snapshotBlocks : undefined
	);
	const snapshotRevision = useProofStore((s) =>
		currentPath ? (s.byPath[currentPath]?.snapshotRevision ?? 0) : 0
	);
	const commentsRaw = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.sidecar?.comments : undefined
	);
	// Server-resolved anchor positions, returned by the same snapshot read as the blocks.
	const commentViews = useProofStore((s) =>
		currentPath ? s.byPath[currentPath]?.commentViews : undefined
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
	/**
	 * Which margin card is expanded, if any. SEPARATE from `threadTarget`: sharing
	 * that state made clicking a card render the old portal popover instead of
	 * expanding the card, so the column was a launcher for the floating thread rather
	 * than the thread's home.
	 *
	 * Held at module scope (keyed by path) rather than in a ref, because the editor does
	 * get remounted — a reply writes the sidecar, the watcher reports an external change,
	 * and the loader swaps the editor out and back. A ref would be recreated by that same
	 * remount, and a tag set on `.ProseMirror` before the send was verifiably gone after
	 * it: the expanded card collapsed the instant you replied, contradicting "successful
	 * ops keep the thread open", while the reply itself saved correctly.
	 */
	const [activeMarginRef, setActiveMarginRef] = useState<string | null>(
		() => expandedMarginByPath.get(currentPath ?? "") ?? null,
	);
	// Record at the moment of the click as well as in the effect below.
	//
	// The effect runs after render, so a remount landing between the click and that run
	// would find nothing stored and re-open collapsed. React runs effects before the
	// browser paints, so that window is small — but this fix could not be confirmed in a
	// browser, and a small window is not a reason to leave a silent failure open when the
	// closure costs one line.
	const setActiveMarginRefNow = useCallback(
		(blockRef: string | null) => {
			const key = currentPath ?? "";
			if (blockRef) remember(expandedMarginByPath, key, blockRef);
			else expandedMarginByPath.delete(key);
			setActiveMarginRef(blockRef);
		},
		[currentPath],
	);
	// The path the current `activeMarginRef` belongs to. Writing the ref under the
	// CURRENT path without this would copy one document's expansion onto another when
	// the reader navigates without a remount: the state still holds document A's ref
	// while `currentPath` already says B, so the write-back would store A's ref as B's.
	const activeMarginPathRef = useRef<string | null>(currentPath ?? null);
	useEffect(() => {
		const key = currentPath ?? "";
		if (activeMarginPathRef.current !== key) {
			// Path changed under us: adopt the new document's own expansion instead of
			// persisting the old document's ref against the new path.
			activeMarginPathRef.current = key;
			setActiveMarginRef(expandedMarginByPath.get(key) ?? null);
			return;
		}
		if (activeMarginRef) remember(expandedMarginByPath, key, activeMarginRef);
		else expandedMarginByPath.delete(key);
	}, [activeMarginRef, currentPath]);
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
				//
				// Resolved threads STAY in the column. Dropping them was a divergence from
				// the contract, and it had a visible consequence: resolving a comment
				// unmounted its card, which unmounted the thread inside it, so a
				// successful Resolve closed the thread and took the reply box with it —
				// exactly what "successful ops keep the thread open" forbids. Keeping the
				// card mounted is also what lets the reviewer reopen it without hunting
				// for the anchor again.
				.map(([blockRef, list]) => ({
					blockRef,
					// Cancelled only. A comment whose anchor is lost keeps its card
					// deliberately (Google Docs keeps it; nothing the user wrote should
					// vanish because a file was saved elsewhere). It is shown as detached
					// and it paints no highlight.
					comments: list.filter((c) => !c.cancelledAt),
				}))
				.filter((t) => t.comments.length > 0),
		[threadCommentsByRef],
	);
	/**
	 * Block offsets for the annotations panel, in the SCROLL CONTAINER'S viewport frame.
	 *
	 * `blockRefPositions.top` includes `scrollTop`, which is what an overlay INSIDE the
	 * scrolling element needs: those children move with the text, so adding the scroll
	 * offset is what keeps them stuck to their block. The comment pips use that map and
	 * are correct.
	 *
	 * The panel is a SIBLING of the scroll container, so it does not move with the text.
	 * Feeding it content coordinates made every card drift DOWN by exactly the scrolled
	 * amount — the further the reader scrolled, the further below its own text each card
	 * sat, which is what the screenshot showed. `viewportTop` is the same measurement
	 * without the scroll term.
	 */
	const marginOffsets = useMemo(() => {
		const map = new Map<string, number>();
		for (const [ref, pos] of blockRefPositions) {
			map.set(ref, pos.viewportTop ?? pos.top);
		}
		return map;
	}, [blockRefPositions]);

	const [hoveredMarginRef, setHoveredMarginRef] = useState<string | null>(null);
	// Drop the expanded card when its comment leaves the column.
	//
	// Refs are content-derived (`sha256(blockMarkdown).slice(0,6)`), so the same text
	// always yields the same ref. Without this, cancelling a comment — which happens
	// when its anchored text is deleted, possibly by an agent editing the file — left
	// `activeMarginRef` pointing at a now-absent card, and a later comment on restored
	// text with that same ref would render pre-expanded for no reason the reader could
	// see.
	//

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
	 * Bumped whenever something reflows the text WITHOUT changing the document.
	 *
	 * The offsets below are pixel positions, so they are invalidated by anything that
	 * moves a block: the annotations panel opening or closing (it narrows the reading
	 * column, so paragraphs wrap taller), the width setting changing, a window resize,
	 * fonts landing. The effect cannot depend on the panel store directly — those hooks
	 * are declared below it — so the value is mirrored into this state from an effect
	 * further down, which is what re-runs the measurement.
	 */
	const [reflowKey, setReflowKey] = useState(0);

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
					// The same measurement WITHOUT the scroll term, for consumers that do
					// not scroll with the document (the annotations panel). Both come from
					// one rect so they cannot describe different revisions.
					viewportTop: rect.top - containerRect.top,
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
		// Re-measure when the LAYOUT changes, not only when the content does.
		//
		// These offsets are pixel positions, so anything that reflows the text
		// invalidates them. Opening the annotations panel narrows the reading column,
		// which makes paragraphs wrap taller and pushes every block below the first
		// further down — measured live at 37px on a six-block document, which put the
		// cards about two lines above the text they annotate. The panel's own width
		// setting does the same thing.
		//
		// A ResizeObserver on the editor content is what makes this correct rather
		// than a list of remembered triggers: it fires for the panel opening, the
		// width setting changing, the window resizing, and fonts landing, which is
		// every case that moved a block without changing the document.
		const observer = new ResizeObserver(() => {
			// Re-run the same measurement in place. Deliberately NOT a state bump on a
			// counter: routing it through the effect would re-stamp refs and re-walk
			// the tree, doing work proportional to the document on every resize tick.
			const rect = container.getBoundingClientRect();
			const next = new Map<string, BlockPosition>();
			for (const el of children) {
				const ref = el.getAttribute("data-block-ref");
				if (!ref) continue;
				const r = el.getBoundingClientRect();
				next.set(ref, {
					top: r.top - rect.top + container.scrollTop,
					viewportTop: r.top - rect.top,
					left: r.left - rect.left,
					width: r.width,
					bottom: r.bottom - rect.top + container.scrollTop,
				});
			}
			if (next.size > 0) setBlockRefPositions(next);
		});
		// Observe the CONTAINER, not just the ProseMirror box.
		//
		// A ResizeObserver on `proseMirror` alone missed the case that matters: opening
		// the panel narrows the column, so the text REWRAPS and every block below the
		// first moves — but the editor box itself keeps the same width and height, so no
		// resize was reported and the stale offsets stood. Measured live, the cards sat
		// 37px above their text for exactly this reason.
		//
		// `box: "border-box"` so a padding change counts, and the container is what the
		// offsets are relative to, so watching it is watching the right thing.
		observer.observe(container);
		return () => observer.disconnect();
	}, [currentPath, snapshotBlockOffset, snapshotBlocks, reflowKey]);


	/**
	 * The single serialization path.
	 *
	 * SUGGESTIONS ARE WRITTEN TO THE FILE, reversing the earlier invariant that the
	 * `.md` stays byte-identical while suggestions are pending. The marks are the record
	 * now: they serialize as `<ins data-id>` / `<del data-id>` (rules in
	 * `to-markdown.ts`), so a suggestion survives a save, a reload, and any reader —
	 * as a Google Docs suggestion lives in the document rather than beside it. The old
	 * sidecar design meant anything that lost the sidecar lost the suggestions outright.
	 *
	 * The byte-identity guard below is a separate concern: it stops a no-op visit from
	 * rewriting the file.
	 */
	const handleUpdate = useCallback(
		({ editor }: { editor: ReturnType<typeof useEditor> }) => {
			if (isLoadingRef.current || isViewingRef.current || !editor) return;
			const html = editor.getHTML();
			const md = htmlToMarkdown(
				html,
				useEditorStore.getState().currentPath ?? undefined,
			);

			// Do not persist a round-trip that changed nothing.
			//
			// Markdown -> HTML -> Markdown is not the identity: a list marker gains a
			// second space (`1. ` -> `1.  `), blank lines acquire trailing whitespace,
			// and the trailing newline is dropped. ProseMirror fires `onUpdate` when the
			// editor becomes editable, so merely OPENING a document for editing
			// rewrote it — measured live: 166 bytes -> 231 bytes with nothing typed.
			// `.md` is the source of truth here, so a no-op visit must not rewrite it.
			//
			// The baseline must be the PREVIOUS SERIALIZATION, not the file's source
			// markdown: `md` here is already round-tripped, so comparing it against the
			// raw file text would never match and the guard would never fire. Storing
			// what we last produced makes "nothing changed" an exact comparison.
			if (lastSerializedRef.current === md) return;
			lastSerializedRef.current = md;

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
		activeRef?: string | null;
		onSelectRef?: (ref: string) => void;
		views?: Record<string, { ref: string | null; offset: number; length: number; status: string }>;
	}>({ blocks: [], comments: [] });
	commentHighlightStateRef.current = {
		blocks: snapshotBlocks.map((b) => ({ ref: b.ref, markdown: b.markdown })),
		comments,
		hoveredRef: hoveredMarginRef,
		activeRef: activeMarginRef,
		onSelectRef: (ref) => selectCommentByRefRef.current?.(ref),
		// Resolved against the very blocks above, so the range and the block list always
		// describe the same revision.
		views: commentViews,
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

	// Re-arm the mode plugin whenever a new editor instance appears.
	//
	// The `suggesting` flag lives in the vendored plugin's state, which is
	// recreated with the editor. Restoring the flag alone would leave the toolbar
	// reading "Suggesting" while the plugin behaved as "editing" — the UI would
	// claim edits were tracked when they were not, which is worse than the reset
	// it replaced.
	useEffect(() => {
		if (!editor) return;
		const { state, view } = editor;
		const want = suggesting;
		if (isSuggestChangesEnabled(state) === want) return;
		(want ? enableSuggestChanges : disableSuggestChanges)(state, view.dispatch);
	}, [editor, suggesting]);

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
		// `activeMarginRef` belongs in this list for the same reason as `hoveredMarginRef`:
		// the plugin reads live state through a ref, so changing the active comment does
		// not dispatch a transaction and nothing would repaint. Without it, CLICKING a
		// comment in the text set the active ref and left the highlight unchanged, while
		// hovering the same comment worked — the two paths differed only by which of
		// these two values had moved.
	}, [editor, snapshotBlocks, comments, currentPath, hoveredMarginRef, activeMarginRef]);
	/**
	 * Every tracked mark in the document, with the range it covers.
	 *
	 * This is the whole suggestion list now: a suggestion IS a mark, so enumerating
	 * marks enumerates suggestions. Read from the live document rather than a store so
	 * it cannot go stale against what the reader sees.
	 *
	 * Grouped by `id`, because the schema splits a run of text across text nodes as
	 * you type - one suggestion is one id covering possibly several ranges - and the
	 * union of those ranges is what the margin card aligns to. Counting ranges instead
	 * of ids reported a single edit as several, which is the bug the count effect
	 * below already guards against.
	 */
	const [trackedMarks, setTrackedMarks] = useState<
		{ id: MarkId; kind: "insert" | "remove" | "modify"; from: number; to: number; attrName?: string | null; previousValue?: unknown; newValue?: unknown }[]
	>([]);
	// Latest collected marks, so `collect` can skip the state write when nothing
	// changed. The listener runs on EVERY ProseMirror transaction — including
	// no-op ones like focus/blur and the annotation-refresh pass — and a fresh
	// array each time re-rendered the whole editor on all of them. With the
	// comment composer (a Radix Popover) open, that render churn re-ran the
	// popover's ref callbacks every commit, and each one flips Radix's internal
	// container state — a nested-update loop React kills with error #185
	// ("Maximum update depth exceeded"), which white-screens the page.
	const collectedMarksRef = useRef<
		{ id: MarkId; kind: "insert" | "remove" | "modify"; from: number; to: number; attrName?: string | null; previousValue?: unknown; newValue?: unknown }[]
	>([]);
	const sameTrackedMarks = (
		a: { id: MarkId; kind: string; from: number; to: number; attrName?: unknown; previousValue?: unknown; newValue?: unknown }[],
		b: { id: MarkId; kind: string; from: number; to: number; attrName?: unknown; previousValue?: unknown; newValue?: unknown }[],
	) =>
		a.length === b.length &&
		a.every((m, i) =>
			m.id === b[i].id &&
			m.kind === b[i].kind &&
			m.from === b[i].from &&
			m.to === b[i].to &&
			m.attrName === b[i].attrName &&
			m.previousValue === b[i].previousValue &&
			m.newValue === b[i].newValue,
		);
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const collect = () => {
			const byId = new Map<MarkId, { id: MarkId; kind: "insert" | "remove" | "modify"; from: number; to: number }>();
			editor.state.doc.descendants((node, pos) => {
				for (const mark of node.marks) {
					const name = mark.type.name;
					const kind =
						name === "deletion" ? "remove" : name === "modification" ? "modify" : name.startsWith("insertion") ? "insert" : null;
					if (!kind) continue;
					// `id` defaults to null on the mark spec, so a mark can exist before
					// the library assigns one. String(null) would be the id "null" and
					// would group every such mark into one bogus card.
					if (mark.attrs.id === null || mark.attrs.id === undefined) continue;
					// Keep the id's ORIGINAL TYPE. The library generates numbers and its
					// settle commands compare with `===`, so stringifying made every
					// approval a silent no-op for a suggestion typed in this session. A
					// mark reloaded from disk parses back to the same number via
					// JSON.parse, so both paths agree.
					const id = mark.attrs.id as MarkId;
					const from = pos;
					const to = pos + node.nodeSize;
					const existing = byId.get(id);
					if (existing) {
						existing.from = Math.min(existing.from, from);
						existing.to = Math.max(existing.to, to);
					} else {
						byId.set(id, {
						id,
						kind,
						from,
						to,
						// A modification mark records what changed (which attribute,
						// from what, to what); the prompt serializer needs those to
						// describe the change. Insertions/deletions carry only text.
						...(kind === "modify" && {
							attrName: typeof mark.attrs.attrName === "string" ? mark.attrs.attrName : null,
							previousValue: mark.attrs.previousValue,
							newValue: mark.attrs.newValue,
						}),
					});
					}
				}
				return true;
			});
			const collected = [...byId.values()].sort((a, b) => a.from - b.from);
			if (sameTrackedMarks(collected, collectedMarksRef.current)) return;
			collectedMarksRef.current = collected;
			setTrackedMarks(collected);
		};
		collect();
		editor.on("transaction", collect);
		return () => {
			editor.off("transaction", collect);
		};
	}, [editor]);
	/**
	 * Vertical offset of each tracked mark, relative to the scroll container.
	 *
	 * Measured from the DOM rather than computed from the ProseMirror position:
	 * `coordsAtPos` gives viewport coordinates that still need the container's own
	 * offset subtracted, and the container scrolls. Reading the rendered element
	 * avoids both steps and matches how block offsets are already measured.
	 */
	const [markOffsets, setMarkOffsets] = useState<Map<MarkId, number>>(new Map());
	useEffect(() => {
		if (trackedMarks.length === 0) {
			setMarkOffsets(new Map());
			return;
		}
		const container = scrollContainerRef.current;
		if (!container) return;
		const next = new Map<MarkId, number>();
		for (const mark of trackedMarks) {
			// `String` is correct here and only here: a CSS selector needs a string, and
			// the DOM attribute is always text. The id's type is preserved everywhere it
			// is used for identity or settlement.
			const el = container.querySelector<HTMLElement>(`[data-id="${String(mark.id)}"]`);
			if (!el) continue;
			next.set(mark.id, el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop);
		}
		setMarkOffsets(next);
	}, [trackedMarks]);

	/**
	 * The pending suggestions the annotations panel lists.
	 *
	 * `text` is read from the document for the card's summary line — it is the words
	 * the mark covers, which is the one thing the old anchored column could not show
	 * (a mark covers a few words, not a block edge). A modification carries its own
	 * before/after in its attributes rather than covering text, so it falls back to
	 * the mark's type name.
	 *
	 * `blockRef` anchors the card beside the block the mark sits in. The panel shows
	 * where a change is AND quotes the words it covers, which is more than either
	 * surface managed alone: the old anchored column had the position but no words,
	 * and the old floating list had the words but no position.
	 *
	 * Resolved by top-level block index — the same `$pos.index(0)` indexing the
	 * comment path uses — because PM doc offsets are not markdown offsets. A mark
	 * whose block cannot be resolved keeps `null`; the panel places it at the top
	 * rather than dropping it, since a change that cannot be seen is a change that
	 * cannot be settled.
	 */
	const panelSuggestions = useMemo(
		() =>
			trackedMarks.map((mark) => {
				let blockRef: string | null = null;
				if (editor) {
					try {
						const $pos = editor.state.doc.resolve(mark.from);
						const index = $pos.depth > 0 ? $pos.index(0) : 0;
						blockRef = suggestionBlocks[index]?.ref ?? null;
					} catch {
						// `resolve` throws on an out-of-range offset, which can happen for one
						// render after the document changes under an existing mark. The card
						// still appears; it just cannot be anchored this frame.
						blockRef = null;
					}
				}
				return {
					id: mark.id,
					kind: mark.kind,
					from: mark.from,
					to: mark.to,
					text:
						mark.kind === "modify"
							? "modification"
							: editor?.state.doc.textBetween(mark.from, mark.to, " ") ?? "",
					blockRef,
				};
			}),
		[trackedMarks, editor, suggestionBlocks],
	);

	/**
	 * Copy-as-prompt items for every tracked mark, so suggested changes reach the
	 * external-agent prompt and not only the margin panel.
	 *
	 * The anchor is quoted from the SNAPSHOT blocks, not the live document: the
	 * prompt tells an agent to apply the change to the FILE, so the quoted anchor
	 * must be text the file actually contains. When that anchor already embeds the
	 * mark's tag (saved suggestion) the item stays bare and the prompt's ending
	 * legend explains the tag syntax; an unsaved mark quotes its words from the
	 * live document instead. The same transient `resolve` caveat as
	 * `panelSuggestions` applies: an out-of-range mark anchors to "document" this
	 * frame.
	 */
	const promptSuggestions = useMemo(
		() =>
			trackedMarks.map((mark) => {
				let blockText: string | undefined;
				let embedded = false;
				if (editor) {
					try {
						const $pos = editor.state.doc.resolve(mark.from);
						const index = $pos.depth > 0 ? $pos.index(0) : 0;
						const markdown = suggestionBlocks[index]?.markdown;
						if (markdown) {
							blockText = markdown.replace(/\s+/g, " ").trim() || undefined;
							// The snapshot is the FILE: when it already carries this
							// mark's tag the suggestion was saved, and the prompt
							// item can lean on the legend instead of re-quoting the
							// words. An unsaved mark is not in the file yet.
							embedded = markdown.includes(`data-id="${mark.id}"`);
						}
					} catch {
						blockText = undefined;
					}
				}
				return {
					kind: mark.kind,
					text:
						mark.kind === "modify"
							? ""
							: editor?.state.doc.textBetween(mark.from, mark.to, " ") ?? "",
					blockText,
					embedded,
					attrName: mark.attrName,
					previousValue: mark.previousValue,
					newValue: mark.newValue,
				};
			}),
		[trackedMarks, editor, suggestionBlocks],
	);

	// The anchored column is COMMENTS ONLY, and is toggled from the TOP BAR — shared
	// chrome that renders in both editing and viewing. It used to be a button inside the
	// editor's own toolbar row, which is `!isViewing`, so it did not exist in view mode at
	// all — the mode comments are most often read in.
	//
	// The store holds the reader's choice; the editor publishes the count, because it is
	// the only thing that can see the document's comments.
	const panelOpen = useAnnotationPanelStore((state) => state.panelOpen);
	const tab = useAnnotationPanelStore((state) => state.tab);
	const setPanelCounts = useAnnotationPanelStore((state) => state.setCounts);
	const revealComments = useAnnotationPanelStore((state) => state.revealComments);

	// Anything that reflows the text without changing the document bumps the key that
	// re-runs the block measurement. The panel opening narrows the reading column, so
	// paragraphs wrap taller and blocks below the first move down; the editor box keeps
	// its own size, so no resize event fires and stale offsets would stand. That stale
	// set put the cards 37px above their text.
	useEffect(() => {
		setReflowKey((k) => k + 1);
	}, [panelOpen, tab, editorMaxW, outlineOpen]);
	// The click handler is installed before this component body has declared
	// `selectCommentByRef` (the extension state is built earlier in the render), so it
	// is reached through a ref. A click cannot arrive before the render completes, which
	// is when this is assigned.
	const selectCommentByRefRef = useRef<((ref: string) => void) | null>(null);

	/**
	 * Clicking a highlighted comment in the TEXT opens its card in the panel.
	 *
	 * The comment highlight's decoration carries a comment id, not a block ref, so the
	 * id is mapped through the same per-comment resolution the decorator used. Doing it
	 * that way keeps the text and the panel describing the same revision: the ref comes
	 * from the resolved view, which is this document's answer, rather than from
	 * `comment.ref`, which may name a block that no longer exists.
	 */
	const selectCommentByRef = useCallback(
		(commentId: string) => {
			const view = commentViews?.[commentId];
			const comment = comments.find((c) => c.id === commentId);
			const blockRef = view?.ref ?? comment?.ref ?? null;
			if (!blockRef) return;
			// Show the panel and land on the Comments tab: the reader asked for a
			// comment, so a Changes tab would hide the very card they clicked for.
			revealComments();
			setActiveMarginRefNow(blockRef);
		},
		[commentViews, comments, revealComments, setActiveMarginRefNow],
	);
	selectCommentByRefRef.current = selectCommentByRef;


	// What the panel renders, from the same pure function the overlay button badges
	// with — so a badge can never advertise a count the panel does not draw.
	const contents = panelContents({
		commentCount: marginThreads.length,
		suggestionCount: panelSuggestions.length,
		panelOpen,
		tab,
	});
	const showCommentCards = contents.comments > 0;
	const showSuggestionCards = contents.suggestions > 0;
	const panelShowingAnything = panelOpen && (showCommentCards || showSuggestionCards);

	/**
	 * The reading column keeps its full width setting; the COMMENT COLUMN is additional
	 * space beside it, not a deduction from it.
	 *
	 * The first version subtracted the column with `min(maxW, 100% - col)`, which BROKE
	 * the width setting: the document was capped at the remaining space, so once the
	 * setting exceeded that cap, Normal and Wide both resolved to the same number — at a
	 * 1253px row, 60rem and 90rem both produced 949px. Wide silently became Normal and the
	 * control looked dead.
	 *
	 * The width setting says how wide the TEXT should be. It must therefore survive the
	 * column being open, which means the column has to come out of the row, not out of
	 * `--editor-max-w`. The row is a flex container, so it already reserves the column:
	 * the document div is `flex-1` and gets `row - column`. The one case that needs
	 * handling is when that leftover is SMALLER than the setting — then the document is
	 * capped by its space (`100%` of the flex item) and simply fills it, which is the
	 * correct degradation: a 42rem "narrow" document cannot be 42rem inside a 30rem gap.
	 *
	 * So the variable is left alone, and centring is preserved by the same `auto` margins
	 * as before — they now centre within the reduced flex area rather than the full row.
	 */
	const editorMaxWWithMargin = editorMaxW;
	useEffect(() => {
		setPanelCounts(marginThreads.length, panelSuggestions.length);
		// Reset when this editor unmounts, or the next document inherits stale counts
		// and the overlay button offers toggles for annotations that are not there.
		return () => setPanelCounts(0, 0);
	}, [marginThreads.length, panelSuggestions.length, setPanelCounts]);


	// Keep the Accept/Reject controls in step with the document. Counted from the
	// live document, so it cannot go stale the way a manually maintained flag can.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const count = () => {
			// One suggestion per distinct mark id. Counting ranges would report a
			// single edit as several, because a run of text is split across text
			// nodes by the schema as the user keeps typing.
			// `MarkId`, not `string`: stringifying here made numeric 1 and legacy "1"
			// one entry, so the count under-reported how many suggestions are pending.
			// The same reasoning as `trackedMarks` - an id is compared by identity
			// elsewhere, so it must not be coerced for convenience.
			const ids = new Set<MarkId>();
			editor.state.doc.descendants((node) => {
				for (const mark of node.marks) {
					if (mark.type.name.startsWith("insertion") ||
						mark.type.name === "deletion" ||
						mark.type.name === "modification") {
						if (mark.attrs.id === null || mark.attrs.id === undefined) continue;
						ids.add(mark.attrs.id as MarkId);
					}
				}
				return true;
			});
			setTrackedCount(ids.size);
		};
		count();
		editor.on("transaction", count);
		return () => {
			editor.off("transaction", count);
		};
	}, [editor]);


	// Stable ref to the editor so callbacks with empty deps reach the live instance.
	editorRef.current = editor;

	// The decoration-based redline is RETIRED.
	//
	// It drew committed agent proposals as word-diff decorations over text that had
	// already been replaced — the same wrong model the old comment pips used: the
	// suggestion is depicted from outside the document instead of living in it.
	// Suggesting mode now expresses an edit as marks IN the document, and a
	// suggestion is surfaced in the margin column beside it, exactly like a comment.
	//
	// The review entry points remain `SuggestionPip` and the review popover, both of
	// which read `pendingSuggestions` directly, so nothing became unreachable.

	useEffect(() => {
		editor?.setEditable(!isViewing);
		if (isViewing) setSourceMode(false);
	}, [editor, isViewing]);

	// When content updates from store (after loadPage), set it in editor
	const prevPathRef = useRef<string | null>(null);
	const renderedKeyRef = useRef<string | null>(null);
	/**
	 * The markdown this editor last produced, so a no-op update can be recognised.
	 *
	 * Kept separate from `renderedKeyRef`: that holds the file's SOURCE markdown,
	 * while this holds the round-tripped form we would write back. Comparing the two
	 * to each other never matches, which is how an earlier version of this guard
	 * ended up inert.
	 */
	const lastSerializedRef = useRef<string | null>(null);
	// Phase 5 (DoD #5): a fingerprint of the annotation state at the last render.
	// When it changes but the MARKDOWN does not, the change is annotation-only
	// and ProseMirror must not be rebuilt. Without this the guard's
	// `annotationChanged` input could only ever be a constant, leaving the
	// protection inert.
	const annotationFingerprint = useMemo(() => {
		// Comments only. Suggestions are document marks now, so a change to one is a
		// change to the markdown, which the guard already compares directly - folding
		// them in here would make the input a constant for them.
		const commentIds = comments.map((c) => `${c.id}:${c.resolved ? 1 : 0}:${c.turns.length}`).join(",");
		return commentIds;
	}, [comments]);
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
			// Seed the baseline with what THIS document serializes to.
			//
			// Resetting to null instead would guarantee the first update after a load
			// writes the file — which is exactly the bug being fixed, since becoming
			// editable fires that first update. Seeding here means the very first
			// no-op round-trip already matches and is skipped.
			// Must match `handleUpdate`'s serialization exactly, or the baseline
			// never matches and every load rewrites the file.
			lastSerializedRef.current = htmlToMarkdown(editor.getHTML(), currentPath ?? undefined);
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
				// Re-seed the no-op baseline from what the editor now holds.
				//
				// Without this the guard compares against a baseline from BEFORE source
				// mode. The baseline is the round-tripped form (`1.  one`) while source
				// mode holds the file's own text (`1. one`), so the comparison misses and
				// the next update — which `setContent` triggers — saves a reformatted
				// document. Measured: opening source mode and closing it again with no
				// edit rewrote the list markers. The content is unchanged either way, so
				// seeding here keeps closing source mode a genuine no-op.
				lastSerializedRef.current = htmlToMarkdown(editor.getHTML(), currentPath ?? undefined);
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
								{!sourceMode && suggesting && hasTrackedChanges && (
									<span className="flex items-center gap-1 mr-2">
										<button
											onClick={() => resolveAllTracked("accept")}
											className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 transition-colors"
											title="Accept every suggestion in this document"
										>
											<Check className="h-3 w-3" />
											Accept all
										</button>
										<button
											onClick={() => resolveAllTracked("reject")}
											className="px-2.5 py-1 text-[11px] rounded-md border border-border text-muted-foreground hover:bg-accent transition-colors"
											title="Reject every suggestion in this document"
										>
											Reject all
										</button>
									</span>
								)}
								{!sourceMode && (
									<button
										onClick={toggleSuggestingMode}
										title={
											suggesting
												? "Suggesting: your edits are tracked until accepted"
												: "Editing: your edits apply directly"
										}
										aria-pressed={suggesting}
										className={`flex items-center gap-1.5 px-3 py-1 mr-2 text-[11px] rounded-md transition-colors border border-border ${
											suggesting
												? "bg-emerald-500/15 text-emerald-700 border-emerald-500/40"
												: "text-muted-foreground hover:bg-accent"
										}`}
									>
										{suggesting ? (
											<PencilLine className="h-3 w-3" />
										) : (
											<PenLine className="h-3 w-3" />
										)}
										{suggesting ? "Suggesting" : "Editing"}
									</button>
								)}
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
								<DocumentOutline
									editor={editor}
									scrollContainerRef={scrollContainerRef}
									open={outlineOpen}
									onOpenChange={setOutlineOpen}
								/>
								<AnnotationsButton />
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

									{/* Comment thread — portal popover, driven by `threadTarget`.
									    This is the PIP path only. Margin cards render their own
									    thread in place, so the two never both open for one
									    comment. Kept for the gutter pips, which still exist
									    for blocks whose comment has no margin card. */}
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

								{/* Google-Docs-style comment margin: COMMENTS ONLY (see
								    comment-margin.tsx). Sits OUTSIDE the scroll container so
								    cards stay put while the document scrolls under them, and
								    the header toggle is what shows or hides it. */}
								{panelShowingAnything && (
									<CommentMargin
										path={currentPath ?? ""}
										threads={marginThreads}
										blockOffsets={marginOffsets}
										activeRef={activeMarginRef}
										onActivate={(blockRef) =>
											// Expand the card IN PLACE — the thread lives in the
											// card rather than in a floating popover.
											//
											// The ternary keeps this idempotent, but it is NOT
											// the collapse path: expanding unmounts the collapsed
											// card whose button called this, so the reader cannot
											// click it a second time. Collapsing is the close
											// control inside the expanded card. (An earlier
											// comment here claimed a second click would collapse;
											// it would not, and there was then no way out at all.)
											setActiveMarginRefNow(
												activeMarginRef === blockRef ? null : blockRef,
											)
										}
										onClose={() => setActiveMarginRefNow(null)}
										suggestions={panelSuggestions}
										onAcceptSuggestion={(id, from, to) =>
											resolveOneTracked(id, from, to, "accept")
										}
										onRejectSuggestion={(id, from, to) =>
											resolveOneTracked(id, from, to, "reject")
										}
										showComments={showCommentCards}
										showSuggestions={showSuggestionCards}
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
							markSuggestions={promptSuggestions}
							resolveSnippet={resolvePromptSnippet}
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
