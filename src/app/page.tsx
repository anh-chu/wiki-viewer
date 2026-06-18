"use client";

import {
	AlertCircle,
	Bot,
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	Download,
	File,
	FilePlus,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	GitBranch,
	Server,
	GitMerge,
	Code2,
	Globe,
	History,
	User,
	Image as ImageIcon,
	Link,
	Loader2,
	Maximize2,
	MoreHorizontal,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Eye,
	EyeOff,
	Pin,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Share,
	Slash,
	SortAsc,
	Sparkles,
	Star,
	Terminal,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { CsvViewer } from "@/components/editor/csv-viewer";
import { KBEditor } from "@/components/editor/editor";
import { FileFallbackViewer } from "@/components/editor/file-fallback-viewer";
import { LargeFileGate } from "@/components/editor/large-file-gate";
import { ImageViewer } from "@/components/editor/image-viewer";
import { MediaViewer } from "@/components/editor/media-viewer";
import { MermaidViewer } from "@/components/editor/mermaid-viewer";
import { NotebookViewer } from "@/components/editor/notebook-viewer";
import { DocxViewer } from "@/components/editor/office/docx-viewer";
import { PptxViewer } from "@/components/editor/office/pptx-viewer";
import { XlsxViewer } from "@/components/editor/office/xlsx-viewer";
import dynamic from "next/dynamic";
// pdf.js touches DOM globals at module load — client-only, no SSR.
const PdfViewer = dynamic(
	() => import("@/components/editor/pdf-viewer").then((m) => m.PdfViewer),
	{ ssr: false },
);
import { SourceViewer } from "@/components/editor/source-viewer";
import { WebsiteViewer } from "@/components/editor/website-viewer";
import { NodeAppViewer } from "@/components/editor/node-app-viewer";
import { DirPicker } from "@/components/dir-picker";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BranchDropdown } from "@/components/wiki/branch-dropdown";
import { getActiveWorkspaceId, withWs, wsFetch } from "@/lib/workspace-client";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthSettingsSheet } from "@/components/auth-settings-sheet";
import { ShareDialog } from "@/components/share-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import { showError, showSuccess } from "@/lib/toast";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useRecentStore } from "@/stores/recent-store";
import { usePinStore, type PinnedEntry } from "@/stores/pin-store";
import { cn } from "@/lib/utils";
import { AIPanel } from "@/components/ai-panel/ai-panel";
import { SearchCommandDialog } from "@/components/search/search-command-dialog";
import { SidebarSearchBox } from "@/components/search/sidebar-search-box";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useEditorStore, prefetchPage } from "@/stores/editor-store";
import {
	useViewWidthStore,
	VIEW_WIDTH_CLASS,
	VIEW_ALIGN_CLASS,
} from "@/stores/view-width-store";
import {
	useSidebarWidthStore,
	SIDEBAR_MIN_WIDTH,
	SIDEBAR_MAX_WIDTH,
} from "@/stores/sidebar-width-store";
import { ViewWidthToggle } from "@/components/view-width-toggle";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import { useShowHiddenStore } from "@/stores/show-hidden-store";
import { useIsMobile } from "@/hooks/use-is-mobile";

function timeAgo(iso: string): string {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const diff = Math.max(0, Date.now() - t);
	const s = Math.floor(diff / 1000);
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

interface TreeNode {
	name: string;
	path: string;
	type: "dir" | "file" | "app" | "node-app";
	size?: number;
	modifiedAt: string;
	children?: TreeNode[];
	expanded?: boolean;
	loading?: boolean;
	git?: { branch: string; dirty: boolean };
}

type ViewerKind =
	| "editor"
	| "csv"
	| "pdf"
	| "mermaid"
	| "notebook"
	| "image"
	| "media"
	| "docx"
	| "xlsx"
	| "pptx"
	| "source"
	| "fallback"
	| "app"
	| "html"
	| "node-app"
	| "text";

// Viewer kinds safe to open at any size: they stream, paginate, or proxy and
// never load the whole file into JS. Everything else goes behind LargeFileGate,
// so a new viewer is fail-safe by default until proven safe here.
const SAFE_VIEWER_KINDS = new Set<ViewerKind>([
	"image",
	"media",
	"pdf",
	"fallback",
	"app",
	"node-app",
	"html",
]);

// Files above this size open behind a confirmation gate for unsafe viewers.
const LARGE_FILE_GATE_BYTES = 5 * 1024 * 1024; // 5 MB

function ext(name: string) {
	return name.split(".").pop()?.toLowerCase() ?? "";
}

function viewerKindFor(
	filename: string,
	nodeType: "file" | "app" | "dir" | "node-app",
): ViewerKind {
	if (nodeType === "node-app") return "node-app";
	if (nodeType === "app") return "app";
	if (nodeType === "dir") return "fallback";
	const base = filename.split("/").pop() ?? filename;
	// Dotfile with no real extension (".env", ".gitignore", ".bashrc"):
	// `".env".split(".").pop()` -> "env", which would match nothing below,
	// so treat any leading-dot name as text and let the viewer sniff bytes.
	if (base.startsWith(".") && base.indexOf(".", 1) === -1) return "source";
	const fileExt = ext(filename);
	// No extension at all ("Makefile", "LICENSE", "Dockerfile"): assume text.
	if (!fileExt) return "source";
	if (["md", "markdown"].includes(fileExt)) return "editor";
	if (fileExt === "txt") return "text";
	if (["csv", "tsv"].includes(fileExt)) return "csv";
	if (fileExt === "pdf") return "pdf";
	if (["mmd", "mermaid"].includes(fileExt)) return "mermaid";
	if (fileExt === "ipynb") return "notebook";
	if (
		["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"].includes(
			fileExt,
		)
	)
		return "image";
	if (
		["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac"].includes(
			fileExt,
		)
	)
		return "media";
	if (fileExt === "docx") return "docx";
	if (["xlsx", "xlsm"].includes(fileExt)) return "xlsx";
	if (fileExt === "pptx") return "pptx";
	if (fileExt === "html") return "html";
	if (
		[
			"py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp", "h",
			"sh", "bash", "zsh", "rb", "php", "swift", "kt", "lua", "sql", "yaml",
			"yml", "toml", "json", "xml", "css", "scss",
		].includes(fileExt)
	)
		return "source";
	// Default: assume text and let SourceViewer sniff the bytes. If the file is
	// actually binary, SourceViewer degrades to a download/reveal fallback.
	// This avoids a brittle text-extension whitelist that always misses
	// something (.env, .ini, .lock, .gradle, .properties, ...).
	return "source";
}

const TEXT_EDITABLE_EXTS = new Set([
	"txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv", "tsv",
	"xml", "html", "css", "js", "ts", "tsx", "jsx", "sh", "bash", "zsh",
	"rb", "py", "go", "rs", "java", "c", "cpp", "h", "php", "swift", "kt",
	"lua", "sql", "scss", "mmd", "mermaid", "ini", "env", "log", "conf",
]);

function isText(name: string) {
	const kind = viewerKindFor(name, "file");
	if (kind === "editor" || kind === "text") return true;
	return TEXT_EDITABLE_EXTS.has(ext(name));
}

function isMarkdown(name: string) {
	return ["md", "markdown"].includes(ext(name));
}
function isImage(name: string) {
	return viewerKindFor(name, "file") === "image";
}
function isHtmlFile(name: string) {
	return viewerKindFor(name, "file") === "html";
}

async function fetchDir(dir: string): Promise<TreeNode[]> {
	const res = await wsFetch(`/api/wiki?dir=${encodeURIComponent(dir)}`);
	if (!res.ok) return [];
	const data: {
		entries: Array<{
			name: string;
			type: "dir" | "file" | "app" | "node-app";
			size?: number;
			modifiedAt: string;
			git?: { branch: string; dirty: boolean };
		}>;
	} = await res.json();
	return data.entries.map((e) => ({
		name: e.name,
		path: dir ? `${dir}/${e.name}` : e.name,
		type: e.type,
		size: e.size,
		modifiedAt: e.modifiedAt,
		expanded: false,
		git: e.git,
	}));
}

// One-shot hover-prefetch cache for directory listings: warmed on tree-row hover,
// consumed (read + deleted) by the first expand so there's no long-lived staleness.
// reloadDir/the file-watcher always fetch fresh and bypass this.
const dirPrefetchCache = new Map<string, TreeNode[]>();
const dirPrefetchInflight = new Map<string, Promise<TreeNode[]>>();

function prefetchDir(dir: string): void {
	if (dirPrefetchCache.has(dir) || dirPrefetchInflight.has(dir)) return;
	const promise = fetchDir(dir)
		.then((children) => {
			dirPrefetchCache.set(dir, children);
			return children;
		})
		.finally(() => dirPrefetchInflight.delete(dir));
	dirPrefetchInflight.set(dir, promise);
	promise.catch(() => {});
}

/** Consume a prefetched (or in-flight) dir listing, if any. One-shot. */
async function takePrefetchedDir(dir: string): Promise<TreeNode[] | null> {
	const ready = dirPrefetchCache.get(dir);
	if (ready) { dirPrefetchCache.delete(dir); return ready; }
	const inflight = dirPrefetchInflight.get(dir);
	if (inflight) { const r = await inflight; dirPrefetchCache.delete(dir); return r; }
	return null;
}

function updateNodes(
	nodes: TreeNode[],
	targetPath: string,
	updater: (n: TreeNode) => TreeNode,
): TreeNode[] {
	return nodes.map((n) => {
		if (n.path === targetPath) return updater(n);
		if (n.children)
			return { ...n, children: updateNodes(n.children, targetPath, updater) };
		return n;
	});
}

function removeNode(nodes: TreeNode[], targetPath: string): TreeNode[] {
	return nodes
		.filter((n) => n.path !== targetPath)
		.map((n) =>
			n.children ? { ...n, children: removeNode(n.children, targetPath) } : n,
		);
}

/**
 * Stable handler bundle passed to FileTree. Every method is referentially stable
 * across Page() renders (backed by a ref dispatcher), so FileTree's React.memo
 * holds and the whole tree skips re-rendering when unrelated Page state changes
 * (dialogs, search, editor typing, sidebar resize, dropdowns, etc.).
 */
interface TreeCtx {
	toggleFolder: (node: TreeNode) => void;
	openViewer: (node: TreeNode) => void;
	copyPath: (path: string) => void;
	copyWikiLink: (name: string) => void;
	copyUrl: (path: string) => void;
	copyRawContent: (path: string) => void;
	copyFormattedContent: (path: string, name: string) => void;
	handleDownload: (node: TreeNode) => void;
	triggerUpload: (dir: string) => void;
	handleCreateFile: () => void;
	handleCreateFolder: () => void;
	handleDragStart: (e: React.DragEvent, node: TreeNode) => void;
	handleDragOver: (e: React.DragEvent, targetPath: string, targetType: "dir" | "root") => void;
	handleDropOnFolder: (e: React.DragEvent, targetDirPath: string) => void;
	handleGitPull: (nodePath: string, parentDir: string) => void;
	handleCheckout: (nodePath: string, branch: string, parentDir: string) => void;
	loadBranches: (nodePath: string) => void;
	prefetch: (node: TreeNode) => void;
	togglePin: (node: TreeNode, wsId: string | null) => void;
	setDragOverPath: (p: string | null) => void;
	setSidebarCollapsed: (b: boolean) => void;
	setBranchDropdownNode: (p: string | null) => void;
	setBranchDropdownPos: (p: { top: number; left: number } | null) => void;
	setNewFileParent: (p: string | null) => void;
	setNewFileName: (s: string) => void;
	setFileCreateError: (s: string | null) => void;
	setNewFolderParent: (p: string | null) => void;
	setNewFolderName: (s: string) => void;
	setFolderError: (s: string | null) => void;
	setDeletingPath: (p: string | null) => void;
	setDeletingIsDir: (b: boolean) => void;
}

interface FileTreeProps {
	ctx: TreeCtx;
	nodes: TreeNode[];
	openPath: string | null;
	dragOverPath: string | null;
	branchDropdownNode: string | null;
	branchDropdownPos: { top: number; left: number } | null;
	nodeBranches: Record<string, { name: string; current: boolean }[]>;
	branchesLoading: Record<string, boolean>;
	checkingOutBranch: string | null;
	pullingRepo: string | null;
	activePaths: Set<string>;
	pins: Array<{ path: string }>;
	isMobile: boolean;
	activeWorkspaceId: string | null;
	newFileParent: string | null;
	newFileName: string;
	fileCreateError: string | null;
	newFolderParent: string | null;
	newFolderName: string;
	folderError: string | null;
	sidebarScrollRef: React.RefObject<HTMLDivElement | null>;
}

// content-visibility:auto lets the browser skip layout/paint for off-screen
// rows — virtualization without JS scroll math, and rows stay in the DOM so
// keyboard nav (querySelectorAll) and Ctrl+F still work. Combined with per-row
// memo (below), large trees stay cheap on both the React and browser sides.
const ROW_CV: React.CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 32px" };

// Shared right-click menu body for any file/dir row (tree, pinned, recent).
function FileContextMenuItems({
	node,
	ctx,
	isPinned,
	activeWorkspaceId,
}: {
	node: TreeNode;
	ctx: TreeCtx;
	isPinned: boolean;
	activeWorkspaceId: string | null;
}) {
	return (
		<ContextMenuContent className="w-48">
			<ContextMenuItem onSelect={() => ctx.copyPath(node.path)}>
				<Copy className="mr-2 h-3.5 w-3.5" />
				Copy path
			</ContextMenuItem>
			{isMarkdown(node.name) && (
				<ContextMenuItem onSelect={() => ctx.copyWikiLink(node.name)}>
					<FileText className="mr-2 h-3.5 w-3.5" />
					Copy wiki link
				</ContextMenuItem>
			)}
			<ContextMenuItem onSelect={() => ctx.copyUrl(node.path)}>
				<Link className="mr-2 h-3.5 w-3.5" />
				Copy URL
			</ContextMenuItem>
			{node.type === "file" && isText(node.name) && (
				<>
					<ContextMenuItem onSelect={() => ctx.copyRawContent(node.path)}>
						<FileText className="mr-2 h-3.5 w-3.5" />
						Copy raw content
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => ctx.copyFormattedContent(node.path, node.name)}>
						<FileText className="mr-2 h-3.5 w-3.5" />
						Copy formatted content
					</ContextMenuItem>
				</>
			)}
			<ContextMenuSeparator />
			{node.type === "dir" && (
				<>
					<ContextMenuItem
						onSelect={() => {
							if (!node.expanded) ctx.toggleFolder(node);
							ctx.setNewFileParent(node.path);
							ctx.setNewFileName("");
							ctx.setFileCreateError(null);
						}}
					>
						<FilePlus className="mr-2 h-3.5 w-3.5" />
						New file here
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => ctx.triggerUpload(node.path)}>
						<Upload className="mr-2 h-3.5 w-3.5" />
						Upload here
					</ContextMenuItem>
					<ContextMenuItem
						onSelect={() => {
							ctx.setNewFolderParent(node.path);
							ctx.setNewFolderName("");
							ctx.setFolderError(null);
						}}
					>
						<FolderPlus className="mr-2 h-3.5 w-3.5" />
						New subfolder
					</ContextMenuItem>
					<ContextMenuSeparator />
				</>
			)}
			<ContextMenuItem onSelect={() => ctx.handleDownload(node)}>
				<Download className="mr-2 h-3.5 w-3.5" />
				{node.type === "file" ? "Download" : "Download as zip"}
			</ContextMenuItem>
			<ContextMenuItem onSelect={() => ctx.togglePin(node, activeWorkspaceId)}>
				<Star className={cn("mr-2 h-3.5 w-3.5", isPinned && "fill-current text-amber-400")} />
				{isPinned ? "Unpin" : "Pin to top"}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				className="text-destructive focus:text-destructive"
				onSelect={() => {
					ctx.setDeletingPath(node.path);
					ctx.setDeletingIsDir(node.type !== "file");
				}}
			>
				<Trash2 className="mr-2 h-3.5 w-3.5" />
				Delete
			</ContextMenuItem>
		</ContextMenuContent>
	);
}

// File-type icon for compact rows (recent/pinned), mirroring the tree row.
function FileTypeIcon({ name, type }: { name: string; type: TreeNode["type"] }) {
	const cls = "h-3.5 w-3.5 shrink-0";
	if (type === "dir") return <Folder className={cn(cls, "text-warning")} />;
	if (type === "app") return <Globe className={cn(cls, "text-foreground/70")} />;
	if (type === "node-app") return <Terminal className={cn(cls, "text-emerald-500")} />;
	if (isHtmlFile(name)) return <Globe className={cn(cls, "text-foreground/60")} />;
	if (isImage(name)) return <ImageIcon className={cn(cls, "text-sunshine-700")} />;
	if (isText(name)) return <FileText className={cn(cls, "text-foreground/70")} />;
	return <File className={cn(cls, "text-foreground/60")} />;
}
interface TreeRowViewProps {
	node: TreeNode;
	depth: number;
	ctx: TreeCtx;
	isMobile: boolean;
	activeWorkspaceId: string | null;
	sidebarScrollRef: React.RefObject<HTMLDivElement | null>;
	isActive: boolean;
	isDragOver: boolean;
	isPinned: boolean;
	isAgentActive: boolean;
	isPulling: boolean;
	branchOpen: boolean;
	branchPos: { top: number; left: number } | null;
	branches: { name: string; current: boolean }[];
	branchLoading: boolean;
	checkingOut: string | null;
	onHoverEnter: (node: TreeNode) => void;
	onHoverLeave: () => void;
}

// Memoized row: re-renders only when its OWN derived props change. Navigation
// (openPath change) re-renders just the two affected rows, not the whole tree.
const TreeRowView = memo(function TreeRowView({
	node, depth, ctx, isMobile, activeWorkspaceId, sidebarScrollRef,
	isActive, isDragOver, isPinned, isAgentActive, isPulling,
	branchOpen, branchPos, branches, branchLoading, checkingOut,
	onHoverEnter, onHoverLeave,
}: TreeRowViewProps) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					role="treeitem"
					tabIndex={0}
					draggable={!isMobile}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							if (node.type === "dir") ctx.toggleFolder(node);
							else if (node.type === "app" || node.type === "node-app") { ctx.openViewer(node); ctx.toggleFolder(node); }
							else ctx.openViewer(node);
						} else if (e.key === "ArrowDown") {
							e.preventDefault();
							const container = sidebarScrollRef.current;
							if (!container) return;
							const items = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
							const idx = items.indexOf(e.currentTarget as HTMLElement);
							items[idx + 1]?.focus();
						} else if (e.key === "ArrowUp") {
							e.preventDefault();
							const container = sidebarScrollRef.current;
							if (!container) return;
							const items = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
							const idx = items.indexOf(e.currentTarget as HTMLElement);
							items[idx - 1]?.focus();
						} else if (e.key === "ArrowRight") {
							e.preventDefault();
							if (node.type === "dir" || node.type === "app" || node.type === "node-app") {
								if (!node.expanded) {
									ctx.toggleFolder(node);
								} else {
									const container = sidebarScrollRef.current;
									if (!container) return;
									const items = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
									const idx = items.indexOf(e.currentTarget as HTMLElement);
									items[idx + 1]?.focus();
								}
							}
						} else if (e.key === "ArrowLeft") {
							e.preventDefault();
							if ((node.type === "dir" || node.type === "app" || node.type === "node-app") && node.expanded) {
								ctx.toggleFolder(node);
							} else if (depth > 0) {
								const container = sidebarScrollRef.current;
								if (!container) return;
								const items = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
								const current = e.currentTarget as HTMLElement;
								const idx = items.indexOf(current);
								const currentPL = Number.parseInt(current.style.paddingLeft ?? "0", 10);
								for (let i = idx - 1; i >= 0; i--) {
									const pl = Number.parseInt(items[i].style.paddingLeft ?? "0", 10);
									if (pl < currentPL) { items[i].focus(); break; }
								}
							}
						}
					}}
					onDragStart={(e) => ctx.handleDragStart(e, node)}
					onDragOver={(e) =>
						node.type === "dir"
							? ctx.handleDragOver(e, node.path, "dir")
							: e.preventDefault()
					}
					onDragLeave={() => ctx.setDragOverPath(null)}
					onDrop={(e) =>
						node.type === "dir"
							? ctx.handleDropOnFolder(e, node.path)
							: e.preventDefault()
					}
					onMouseEnter={() => onHoverEnter(node)}
					onMouseLeave={onHoverLeave}
					className={cn(
						"tree-row-reveal flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer group transition-colors select-none touch-target",
						isActive
							? "bg-accent-soft text-foreground font-medium"
							: "hover:bg-muted",
						isDragOver && "ring-2 ring-primary bg-primary-soft",
						node.name.startsWith(".") && "opacity-40",
					)}
					style={{ paddingLeft: `${depth * 14 + 8}px`, ...ROW_CV }}
					onClick={() => {
						if (node.type === "dir") ctx.toggleFolder(node);
						else if (node.type === "app" || node.type === "node-app") { ctx.openViewer(node); ctx.toggleFolder(node); if (isMobile) ctx.setSidebarCollapsed(true); }
						else { ctx.openViewer(node); if (isMobile) ctx.setSidebarCollapsed(true); }
					}}
				>
					{(node.type === "dir" || node.type === "app" || node.type === "node-app") ? (
						node.loading ? (
							<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
						) : (
							<ChevronRight
								className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out"
								style={{ transform: node.expanded ? "rotate(90deg)" : "rotate(0deg)" }}
							/>
						)
					) : (
						<span className="w-3.5 shrink-0" />
					)}

					<span className="editorial-tree-typeicon">{node.type === "dir" ? (
						node.expanded ? (
							<FolderOpen className={cn("h-4 w-4 shrink-0", !isActive && "text-warning")} />
						) : (
							<Folder className={cn("h-4 w-4 shrink-0", !isActive && "text-warning")} />
						)
					) : node.type === "app" ? (
						<Globe className={cn("h-4 w-4 shrink-0", !isActive && "text-foreground/70")} />
					) : node.type === "node-app" ? (
						<Terminal className={cn("h-4 w-4 shrink-0", !isActive && "text-emerald-500")} />
					) : isHtmlFile(node.name) ? (
						<Globe className={cn("h-4 w-4 shrink-0", !isActive && "text-foreground/60")} />
					) : isImage(node.name) ? (
						<ImageIcon className={cn("h-4 w-4 shrink-0", !isActive && "text-sunshine-700")} />
					) : isText(node.name) ? (
						<FileText className={cn("h-4 w-4 shrink-0", !isActive && "text-foreground/70")} />
					) : (
						<File className={cn("h-4 w-4 shrink-0", !isActive && "text-foreground/60")} />
					)}</span>

					<span className="min-w-0 flex-1 truncate">{node.name}</span>

					{/* Git repo badge */}
					{node.git && (
						<span className="relative flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
							<button
								data-branch-trigger
								type="button"
								className="flex items-center gap-0.5 hover:text-foreground"
								title="Switch branch"
								onClick={(e) => {
									e.stopPropagation();
									if (branchOpen) { ctx.setBranchDropdownNode(null); ctx.setBranchDropdownPos(null); return; }
									const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
									ctx.setBranchDropdownPos({ top: rect.bottom + 4, left: rect.left });
									ctx.setBranchDropdownNode(node.path);
									ctx.loadBranches(node.path);
								}}
							>
								<GitBranch className="h-2.5 w-2.5" />
								{node.git.branch}
								{node.git.dirty && <span className="ml-0.5 text-warning">*</span>}
							</button>
							{isPulling ? (
								<Loader2 className="ml-0.5 h-2.5 w-2.5 animate-spin" />
							) : (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										const parentDir = node.path.includes("/")
											? node.path.substring(0, node.path.lastIndexOf("/"))
											: "";
										ctx.handleGitPull(node.path, parentDir);
									}}
									className="ml-0.5 text-muted-foreground hover:text-foreground"
									title="Pull latest"
								>
									<RefreshCw className="h-2.5 w-2.5" />
								</button>
							)}
							{branchOpen && branchPos && (
								<BranchDropdown
									pos={branchPos}
									branches={branches}
									loading={branchLoading}
									busyName={checkingOut}
									disabled={checkingOut !== null}
									onPick={(name) => {
										const parentDir = node.path.includes("/")
											? node.path.substring(0, node.path.lastIndexOf("/"))
											: "";
										ctx.handleCheckout(node.path, name, parentDir);
									}}
									onClose={() => { ctx.setBranchDropdownNode(null); ctx.setBranchDropdownPos(null); }}
								/>
							)}
						</span>
					)}

					{/* Agent presence dot */}
					{isAgentActive && (
						<span
							className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse"
							title="Agent recently active"
						/>
					)}

					<div
						className="hover-reveal flex max-w-0 shrink-0 items-center overflow-hidden opacity-0 transition-all duration-150 group-hover:max-w-7 group-hover:opacity-100 focus-within:max-w-7 focus-within:opacity-100"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
									title="File actions"
								>
									<MoreHorizontal className="h-3.5 w-3.5" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-48">
								<DropdownMenuItem onClick={() => ctx.copyPath(node.path)}>
									<Copy className="mr-2 h-3.5 w-3.5" />
									Copy path
								</DropdownMenuItem>
								{isMarkdown(node.name) && (
									<DropdownMenuItem onClick={() => ctx.copyWikiLink(node.name)}>
										<FileText className="mr-2 h-3.5 w-3.5" />
										Copy wiki link
									</DropdownMenuItem>
								)}
								<DropdownMenuItem onClick={() => ctx.copyUrl(node.path)}>
									<Link className="mr-2 h-3.5 w-3.5" />
									Copy URL
								</DropdownMenuItem>
								{node.type === "file" && isText(node.name) && (
									<>
										<DropdownMenuItem onClick={() => ctx.copyRawContent(node.path)}>
											<FileText className="mr-2 h-3.5 w-3.5" />
											Copy raw content
										</DropdownMenuItem>
										<DropdownMenuItem onClick={() => ctx.copyFormattedContent(node.path, node.name)}>
											<FileText className="mr-2 h-3.5 w-3.5" />
											Copy formatted content
										</DropdownMenuItem>
									</>
								)}
								<DropdownMenuSeparator />
								{node.type === "dir" && (
									<>
										<DropdownMenuItem
											onClick={async () => {
												if (!node.expanded) ctx.toggleFolder(node);
												ctx.setNewFileParent(node.path);
												ctx.setNewFileName("");
												ctx.setFileCreateError(null);
											}}
										>
											<FilePlus className="mr-2 h-3.5 w-3.5" />
											New file here
										</DropdownMenuItem>
										<DropdownMenuItem onClick={() => ctx.triggerUpload(node.path)}>
											<Upload className="mr-2 h-3.5 w-3.5" />
											Upload here
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => {
												ctx.setNewFolderParent(node.path);
												ctx.setNewFolderName("");
												ctx.setFolderError(null);
											}}
										>
											<FolderPlus className="mr-2 h-3.5 w-3.5" />
											New subfolder
										</DropdownMenuItem>
										<DropdownMenuSeparator />
									</>
								)}
								<DropdownMenuItem onClick={() => ctx.handleDownload(node)}>
									<Download className="mr-2 h-3.5 w-3.5" />
									{node.type === "file" ? "Download" : "Download as zip"}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => ctx.togglePin(node, activeWorkspaceId)}
								>
									<Star className={cn("mr-2 h-3.5 w-3.5", isPinned && "fill-current text-amber-400")} />
									{isPinned ? "Unpin" : "Pin to top"}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => {
										ctx.setDeletingPath(node.path);
										ctx.setDeletingIsDir(node.type !== "file");
									}}
								>
									<Trash2 className="mr-2 h-3.5 w-3.5" />
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</ContextMenuTrigger>
			<FileContextMenuItems
				node={node}
				ctx={ctx}
				isPinned={isPinned}
				activeWorkspaceId={activeWorkspaceId}
			/>
		</ContextMenu>
	);
});

const FileTree = memo(function FileTree(p: FileTreeProps) {
	const {
		ctx,
		openPath,
		dragOverPath,
		branchDropdownNode,
		branchDropdownPos,
		nodeBranches,
		branchesLoading,
		checkingOutBranch,
		pullingRepo,
		activePaths,
		pins,
		isMobile,
		activeWorkspaceId,
		newFileParent,
		newFileName,
		fileCreateError,
		newFolderParent,
		newFolderName,
		folderError,
		sidebarScrollRef,
	} = p;

	const showHidden = useShowHiddenStore((s) => s.showHidden);

	// Hover-intent prefetch: a single shared timer so only the row the pointer
	// settles on (>120ms) is prefetched — passing the cursor over rows doesn't
	// fire a request per row. Stable identities so TreeRowView's memo holds.
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onHoverEnter = useCallback((node: TreeNode) => {
		const isCollapsedDir =
			(node.type === "dir" || node.type === "app" || node.type === "node-app") &&
			!node.expanded &&
			node.children === undefined;
		if (node.type !== "file" && !isCollapsedDir) return;
		if (hoverTimer.current) clearTimeout(hoverTimer.current);
		hoverTimer.current = setTimeout(() => ctx.prefetch(node), 120);
	}, [ctx]);
	const onHoverLeave = useCallback(() => {
		if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
	}, []);

	// Flatten the visible tree into a list. Removes the recursion that blocks
	// per-row memo and lets create-inputs / empty markers be plain siblings.
	// Recomputed only when the tree shape or which folder is mid-create changes.
	const flat = useMemo(() => {
		const out: Array<{ kind: "row" | "newfolder" | "newfile" | "empty"; node: TreeNode; depth: number }> = [];
		const walk = (nodes: TreeNode[], depth: number) => {
			for (const node of nodes) {
				if (!showHidden && node.name.startsWith(".")) continue;
				out.push({ kind: "row", node, depth });
				if (node.type === "dir") {
					if (newFolderParent === node.path) out.push({ kind: "newfolder", node, depth });
					if (newFileParent === node.path) out.push({ kind: "newfile", node, depth });
				}
				if ((node.type === "dir" || node.type === "app" || node.type === "node-app") && node.expanded) {
					if (node.children && node.children.length > 0) walk(node.children, depth + 1);
					else if (node.children?.length === 0) out.push({ kind: "empty", node, depth });
				}
			}
		};
		walk(p.nodes, 0);
		return out;
	}, [p.nodes, newFileParent, newFolderParent, showHidden]);

	return (
		<>
			{flat.map((item) => {
				const { node, depth } = item;
				if (item.kind === "row") {
					const branchOpen = branchDropdownNode === node.path;
					return (
						<TreeRowView
							key={node.path}
							node={node}
							depth={depth}
							ctx={ctx}
							isMobile={isMobile}
							activeWorkspaceId={activeWorkspaceId}
							sidebarScrollRef={sidebarScrollRef}
							isActive={openPath === node.path}
							isDragOver={dragOverPath === node.path}
							isPinned={pins.some((pin) => pin.path === node.path)}
							isAgentActive={activePaths.has(node.path)}
							isPulling={pullingRepo === node.path}
							branchOpen={branchOpen}
							branchPos={branchOpen ? branchDropdownPos : null}
							branches={node.git ? (nodeBranches[node.path] ?? []) : []}
							branchLoading={node.git ? !!branchesLoading[node.path] : false}
							checkingOut={branchOpen ? checkingOutBranch : null}
							onHoverEnter={onHoverEnter}
							onHoverLeave={onHoverLeave}
						/>
					);
				}
				if (item.kind === "newfolder") {
					return (
						<div
							key={`nf-${node.path}`}
							className="flex items-center gap-1.5 px-2 py-1"
							style={{ paddingLeft: `${(depth + 1) * 14 + 8}px`, ...ROW_CV }}
						>
							<span className="w-3.5 shrink-0" />
							<Folder className="h-4 w-4 shrink-0 text-warning" />
							<input
								className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
								placeholder="Folder name"
								value={newFolderName}
								onChange={(e) => ctx.setNewFolderName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") ctx.handleCreateFolder();
									if (e.key === "Escape") { ctx.setNewFolderParent(null); ctx.setNewFolderName(""); }
								}}
							/>
							{folderError && <span className="text-xs text-destructive">{folderError}</span>}
							<Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={ctx.handleCreateFolder}>
								<Check className="h-3 w-3" />
							</Button>
							<Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { ctx.setNewFolderParent(null); ctx.setNewFolderName(""); }}>
								<X className="h-3 w-3" />
							</Button>
						</div>
					);
				}
				if (item.kind === "newfile") {
					return (
						<div
							key={`ff-${node.path}`}
							className="flex items-center gap-1.5 px-2 py-1"
							style={{ paddingLeft: `${(depth + 1) * 14 + 8}px`, ...ROW_CV }}
						>
							<span className="w-3.5 shrink-0" />
							<FileText className="h-4 w-4 shrink-0 text-accent" />
							<input
								autoFocus
								className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
								placeholder="filename (default .md)"
								value={newFileName}
								onChange={(e) => ctx.setNewFileName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") ctx.handleCreateFile();
									if (e.key === "Escape") { ctx.setNewFileParent(null); ctx.setNewFileName(""); }
								}}
							/>
							{fileCreateError && <span className="text-xs text-destructive">{fileCreateError}</span>}
							<Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={ctx.handleCreateFile}>
								<Check className="h-3 w-3" />
							</Button>
							<Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => { ctx.setNewFileParent(null); ctx.setNewFileName(""); }}>
								<X className="h-3 w-3" />
							</Button>
						</div>
					);
				}
				// empty
				return (
					<div
						key={`empty-${node.path}`}
						className="text-xs text-muted-foreground/50 py-0.5"
						style={{ paddingLeft: `${(depth + 1) * 14 + 8 + 14 + 6 + 16 + 6}px`, ...ROW_CV }}
					>
						Empty
					</div>
				);
			})}
		</>
	);
});

export default function Page() {
	const slugsLoadedAt = useWikiSlugsStore((s) => s.loadedAt);
	useEffect(() => {
		void useWikiSlugsStore.getState().load();
	}, []);
	void slugsLoadedAt;

	// null = checking, false = not set, true = ready
	const [rootConfigured, setRootConfigured] = useState<boolean | null>(null);
	const [rootPath, setRootPath] = useState<string | null>(null);
	// Workspace state
	const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(() =>
		typeof window !== "undefined" ? getActiveWorkspaceId() : null
	);
	const [workspaces, setWorkspaces] = useState<Array<{id:string;name:string;rootDir:string;lastOpenedAt?:string;createdAt:string;readOnly?:boolean;git?:{remoteUrl:string;branch?:string;username?:string;lastPulledAt?:string;lastSha?:string;lastError?:string};ssh?:{host:string}}>>([]);
	const [isWsAdmin, setIsWsAdmin] = useState(false);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
	const [refreshingWsId, setRefreshingWsId] = useState<string | null>(null);
	const [wsBranches, setWsBranches] = useState<Record<string, string[]>>({});
	const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
	const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(null);
	const [branchPickerWsId, setBranchPickerWsId] = useState<string | null>(null);
	const [wsBranchPos, setWsBranchPos] = useState<{ top: number; left: number } | null>(null);

	const loadWorkspaces = useCallback(async () => {
		try {
			const res = await fetch("/api/system/workspaces");
			if (!res.ok) throw new Error("Failed");
			const d: { workspaces: Array<{id:string;name:string;rootDir:string;lastOpenedAt?:string;createdAt:string;readOnly?:boolean;git?:{remoteUrl:string;branch?:string;username?:string;lastPulledAt?:string;lastSha?:string;lastError?:string};ssh?:{host:string}}>; isAdmin: boolean } = await res.json();
			setWorkspaces(d.workspaces);
			setIsWsAdmin(d.isAdmin);
			if (d.workspaces.length > 0) {
				setRootConfigured(true);
				const urlWsId = new URLSearchParams(window.location.search).get("ws");
				const inList = urlWsId ? d.workspaces.find((w) => w.id === urlWsId) : null;
				const active = inList ?? [...d.workspaces].sort(
					(a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)
				)[0];
				setActiveWorkspaceId(active.id);
				setRootPath(active.rootDir);
				if (!inList) {
					const u = new URL(location.href);
					u.searchParams.set("ws", active.id);
					history.replaceState(null, "", u.toString());
				}
			} else {
				setRootConfigured(false);
			}
		} catch {
			setRootConfigured(false);
		}
	}, []);

	useEffect(() => {
		void loadWorkspaces();
	}, [loadWorkspaces]);

	const editorCurrentPath = useEditorStore((s) => s.currentPath);

	// Recent files
	const recents = useRecentStore((s) => s.recents);
	const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
	const [recentCollapsed, setRecentCollapsed] = useState(true);

	// Pins
	const pins = usePinStore((s) => s.pins);

	// Sidebar scroll container ref (for keyboard nav)
	const sidebarScrollRef = useRef<HTMLDivElement>(null);

	// Agent presence: paths touched by agents in last 60s
	const activity = useAIPanelStore((s) => s.activity);
	const activePaths = useMemo(() => {
		const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
		const paths = new Set<string>();
		for (const ev of activity) {
			// Only agent-authored events count as "agent presence".
			if (ev.at >= cutoff && ev.path && ev.by?.startsWith("ai:"))
				paths.add(ev.path);
		}
		return paths;
	}, [activity]);

	// Poll activity for presence indicator
	useEffect(() => {
		const load = () => { void useAIPanelStore.getState().loadActivity(); };
		load();
		const id = setInterval(load, 10_000);
		return () => clearInterval(id);
	}, []);

	// Reload recents + pins when workspace changes
	useEffect(() => {
		useRecentStore.getState().loadForWorkspace(activeWorkspaceId);
		usePinStore.getState().loadForWorkspace(activeWorkspaceId);
	}, [activeWorkspaceId]);

	// Speculative warm-up: at idle, prefetch the markdown files the user is most
	// likely to open next — pins and recents (the top of the sidebar). prefetchPage
	// dedups, so this is a no-op for already-cached pages. Bounded to keep it cheap.
	useEffect(() => {
		const paths = [
			...pins.map((p) => p.path),
			...recents.slice(0, 8).map((r) => r.path),
		]
			.filter((p, i, arr) => isMarkdown(p) && arr.indexOf(p) === i)
			.slice(0, 12);
		if (paths.length === 0) return;
		const ric: (cb: () => void) => number =
			typeof window !== "undefined" && "requestIdleCallback" in window
				? (cb) => (window as unknown as { requestIdleCallback: (c: () => void) => number }).requestIdleCallback(cb)
				: (cb) => window.setTimeout(cb, 400);
		const id = ric(() => { for (const p of paths) prefetchPage(p); });
		return () => {
			if (typeof window !== "undefined" && "cancelIdleCallback" in window) {
				(window as unknown as { cancelIdleCallback: (h: number) => void }).cancelIdleCallback(id);
			} else {
				clearTimeout(id);
			}
		};
	}, [pins, recents]);

	// Path captured from the URL at first render, before any effect can clear it.
	// Restore reads from this ref (never the live URL) so URL sync can't break it.
	const initialUrlPathRef = useRef<string | null>(
		typeof window !== "undefined"
			? new URLSearchParams(window.location.search).get("path")
			: null,
	);
	const didRestoreRef = useRef(false);

	const [roots, setRoots] = useState<TreeNode[]>([]);
	const [rootLoaded, setRootLoaded] = useState(false);
	const [rootLoading, setRootLoading] = useState(false);
	const rootLoadingRef = useRef(false);
	const [refreshingTree, setRefreshingTree] = useState(false);

	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const uploadDirRef = useRef<string>("");

	const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
	const [newFolderName, setNewFolderName] = useState("");
	const [folderError, setFolderError] = useState<string | null>(null);

	const [newFileParent, setNewFileParent] = useState<string | null>(null);
	const [newFileName, setNewFileName] = useState("");
	const [fileCreateError, setFileCreateError] = useState<string | null>(null);

	const [deletingPath, setDeletingPath] = useState<string | null>(null);
	const [deletingIsDir, setDeletingIsDir] = useState(false);

	const [openFile, setOpenFile] = useState<{
		path: string;
		name: string;
		nodeType: "file" | "app" | "node-app";
		size?: number;
	} | null>(null);
	// Path the user clicked "open anyway" for. Keyed by path so confirming one
	// large file does not open the next.
	const [gateBypassPath, setGateBypassPath] = useState<string | null>(null);
	const [appFullscreen, setAppFullscreen] = useState(false);
	const [appKey, setAppKey] = useState(0);
	const [viewerKey, setViewerKey] = useState(0);
	const isMobile = useIsMobile();
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const sidebarWidth = useSidebarWidthStore((s) => s.width);
	const showHidden = useShowHiddenStore((s) => s.showHidden);
	const setSidebarWidth = useSidebarWidthStore((s) => s.setWidth);
	// Mobile: when the viewport is mobile, the sidebar defaults to closed.
	// Re-runs when isMobile flips (orientation change, devtools resize).
	useEffect(() => {
		if (isMobile) setSidebarCollapsed(true);
	}, [isMobile]);
	const [sidebarResizing, setSidebarResizing] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
const [shareDialogOpen, setShareDialogOpen] = useState(false);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [fileRevision, setFileRevision] = useState(0);
	const [fileLoading, setFileLoading] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [htmlSourceMode, setHtmlSourceMode] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Drag state
	const dragNodeRef = useRef<TreeNode | null>(null);
	const [dragOverPath, setDragOverPath] = useState<string | null>(null);

	// Refs for watcher handler (avoids stale closures in the SSE effect)
	const openFileRef = useRef<typeof openFile>(null);
	const editingRef = useRef(false);
	const refreshViewerRef = useRef<() => Promise<void>>(async () => {});

	useEffect(() => {
		if (rootLoaded || rootLoadingRef.current) return;
		rootLoadingRef.current = true;
		setRootLoading(true);

		fetchDir("")
			.then((nodes) => {
				setRoots(nodes);
				setRootLoaded(true);
				setRootLoading(false);
			})
			.catch(() => {
				rootLoadingRef.current = false;
				setRootLoading(false);
			});
	}, [rootLoaded]);

	// Expand every ancestor folder of `p` so the file is visible in the tree.
	// Best-effort: requires the root nodes to already be loaded.
	const revealPath = useCallback(async (p: string) => {
		const parts = p.split("/");
		if (parts.length <= 1) return;

		// Fetch every ancestor's children first. We must NOT apply them with one
		// setRoots per level: those updaters run against the same stale `prev`
		// snapshot, so a nested prefix isn't in the tree yet and updateNodes
		// silently no-ops (only the top level ever matched). Collect all levels,
		// then splice them in a single pass so each parent's children exist before
		// the next level is inserted.
		const levels: { prefix: string; children: TreeNode[] }[] = [];
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
			levels.push({ prefix, children: await fetchDir(prefix) });
		}

		setRoots((prev) => {
			let next = prev;
			for (const { prefix: pfx, children } of levels) {
				next = updateNodes(next, pfx, (n) => ({
					...n,
					children,
					expanded: true,
				}));
			}
			return next;
		});
	}, []);

	const reloadDir = useCallback(async (dir: string) => {
		const fresh = await fetchDir(dir);
		if (dir === "") {
			// Merge: keep expanded state + loaded children for nodes that still
			// exist. A blind setRoots(fresh) would collapse the tree and wipe any
			// expansion done by revealPath on reload (watcher fires this often).
			setRoots((prev) => {
				const prevByPath = new Map(prev.map((n) => [n.path, n]));
				return fresh.map((n) => {
					const old = prevByPath.get(n.path);
					if (old && (old.type === "dir" || old.type === "app")) {
						return {
							...n,
							expanded: old.expanded,
							children: old.children,
						};
					}
					return n;
				});
			});
		} else {
			setRoots((prev) =>
				updateNodes(prev, dir, (n) => ({
					...n,
					children: fresh,
					expanded: true,
				})),
			);
		}
	}, []);

	const [pullingRepo, setPullingRepo] = useState<string | null>(null);

	// Git file info (last author + date for open file)
	const [gitFileInfo, setGitFileInfo] = useState<{ sha: string; author: string; date: string } | null>(null);

	// History panel
	const [showHistory, setShowHistory] = useState(false);
	const [historyCommits, setHistoryCommits] = useState<{ sha: string; shortSha: string; message: string; author: string; date: string }[]>([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [selectedDiffSha, setSelectedDiffSha] = useState<string | null>(null);
	const [diffContent, setDiffContent] = useState<string | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);

	// Branch switcher
	const [nodeBranches, setNodeBranches] = useState<Record<string, { name: string; current: boolean }[]>>({});
	const [branchesLoading, setBranchesLoading] = useState<Record<string, boolean>>({});
	const [checkingOutBranch, setCheckingOutBranch] = useState<string | null>(null);
	const [branchDropdownNode, setBranchDropdownNode] = useState<string | null>(null);
	const [branchDropdownPos, setBranchDropdownPos] = useState<{ top: number; left: number } | null>(null);

	const handleGitPull = useCallback(async (nodePath: string, parentDir: string) => {
		if (pullingRepo) return;
		setPullingRepo(nodePath);
		try {
			const res = await wsFetch("/api/wiki/git-pull", {
				method: "POST",
				body: JSON.stringify({ path: nodePath }),
			});
			if (!res.ok) {
				const e: { error?: string; message?: string } = await res.json();
				showError(e.message ?? e.error ?? "Pull failed");
				return;
			}
			const data: { branch: string; sha: string } = await res.json();
			showSuccess(`Pulled ${nodePath} (${data.branch} @ ${data.sha.slice(0, 7)})`);
			await reloadDir(parentDir);
		} catch {
			showError("Pull failed");
		} finally {
			setPullingRepo(null);
		}
	}, [pullingRepo, reloadDir]);

	// Reset history panel when file changes
	useEffect(() => {
		setShowHistory(false);
		setHistoryCommits([]);
		setSelectedDiffSha(null);
		setDiffContent(null);
	}, [openFile?.path]);

	// Fetch git metadata for open file. Keyed on path only: re-fetching on every
	// openFile object re-ref (unrelated re-renders) wastes a git round-trip.
	const openPath = openFile?.path;
	useEffect(() => {
		if (!openPath) { setGitFileInfo(null); return; }
		let cancelled = false;
		// Debounced: rapid navigation shouldn't fire a git round-trip per pass-through.
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const res = await wsFetch(`/api/wiki/git-file-info?path=${encodeURIComponent(openPath)}`);
					if (cancelled) return;
					if (!res.ok) { setGitFileInfo(null); return; }
					const d: { info: { sha: string; author: string; date: string } | null } = await res.json();
					if (!cancelled) setGitFileInfo(d.info);
				} catch { if (!cancelled) setGitFileInfo(null); }
			})();
		}, 200);
		return () => { cancelled = true; clearTimeout(timer); };
	}, [openPath]);

	const loadHistory = useCallback(async () => {
		if (!openFile) return;
		const path = openFile.path;
		setShowHistory(true);
		setHistoryLoading(true);
		setHistoryCommits([]);
		setSelectedDiffSha(null);
		setDiffContent(null);
		try {
			const res = await wsFetch(`/api/wiki/git-history?path=${encodeURIComponent(path)}`);
			if (!res.ok) { showError("Could not load history"); return; }
			const d: { commits: { sha: string; shortSha: string; message: string; author: string; date: string }[] } = await res.json();
			if (openFile.path === path) setHistoryCommits(d.commits);
		} catch { showError("Could not load history"); }
		finally { setHistoryLoading(false); }
	}, [openFile]);

	const selectDiff = useCallback(async (sha: string) => {
		if (!openFile) return;
		if (selectedDiffSha === sha) { setSelectedDiffSha(null); setDiffContent(null); return; }
		const path = openFile.path;
		const targetSha = sha;
		setSelectedDiffSha(sha);
		setDiffLoading(true);
		setDiffContent(null);
		try {
			const res = await wsFetch(`/api/wiki/git-diff?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(sha)}`);
			if (!res.ok) { showError("Could not load diff"); return; }
			const d: { diff: string } = await res.json();
			if (openFile.path === path && selectedDiffSha === targetSha) setDiffContent(d.diff);
		} catch { showError("Could not load diff"); }
		finally { setDiffLoading(false); }
	}, [openFile, selectedDiffSha]);

	const loadBranches = useCallback(async (nodePath: string) => {
		if (nodeBranches[nodePath] || branchesLoading[nodePath]) return;
		let cancelled = false;
		setBranchesLoading((prev) => ({ ...prev, [nodePath]: true }));
		try {
			const res = await wsFetch(`/api/wiki/git-branches?path=${encodeURIComponent(nodePath)}`);
			if (cancelled) return;
			if (!res.ok) { showError("Could not load branches"); return; }
			const d: { branches: { name: string; current: boolean }[] } = await res.json();
			if (!cancelled) setNodeBranches((prev) => ({ ...prev, [nodePath]: d.branches }));
		} catch { if (!cancelled) showError("Could not load branches"); }
		finally { if (!cancelled) setBranchesLoading((prev) => ({ ...prev, [nodePath]: false })); }
		return () => { cancelled = true; };
	}, [nodeBranches, branchesLoading]);

	const handleCheckout = useCallback(async (nodePath: string, branch: string, parentDir: string) => {
		if (checkingOutBranch) return;
		setCheckingOutBranch(branch);
		try {
			const res = await wsFetch("/api/wiki/git-checkout", {
				method: "POST",
				body: JSON.stringify({ path: nodePath, branch }),
			});
			if (res.status === 409) { showError("Repository has uncommitted changes"); return; }
			if (!res.ok) { const e: { error?: string } = await res.json(); showError(e.error ?? "Checkout failed"); return; }
			const d: { branch: string; sha: string } = await res.json();
			showSuccess(`Switched to ${d.branch}`);
			// Invalidate cached branches so next open re-fetches
			setNodeBranches((prev) => { const n = { ...prev }; delete n[nodePath]; return n; });
			setBranchDropdownNode(null);
			setBranchDropdownPos(null);
			await reloadDir(parentDir);
		} catch { showError("Checkout failed"); }
		finally { setCheckingOutBranch(null); }
	}, [checkingOutBranch, reloadDir]);

	const collectExpandedPaths = useCallback((nodes: TreeNode[]): string[] => {
		const paths: string[] = [];
		for (const n of nodes) {
			if ((n.type === "dir" || n.type === "app" || n.type === "node-app") && n.expanded && n.children) {
				paths.push(n.path);
				paths.push(...collectExpandedPaths(n.children));
			}
		}
		return paths;
	}, []);

	const refreshTree = useCallback(async () => {
		setRefreshingTree(true);
		try {
			const expandedPaths = collectExpandedPaths(roots);
			const fresh = await fetchDir("");
			setRoots(fresh);
			for (const p of expandedPaths) {
				const dirFresh = await fetchDir(p);
				setRoots((prev) =>
					updateNodes(prev, p, (n) => ({
						...n,
						children: dirFresh,
						expanded: true,
					})),
				);
			}
		} finally {
			setRefreshingTree(false);
		}
	}, [roots, collectExpandedPaths]);

	const refreshViewer = useCallback(async () => {
		if (!openFile) return;
		if (isMarkdown(openFile.name)) {
			setFileLoading(true);
			try {
				await useEditorStore.getState().loadPage(openFile.path);
			} finally {
				setFileLoading(false);
			}
			return;
		}
		const kind = viewerKindFor(openFile.name, openFile.nodeType);
		if (!["editor", "text"].includes(kind) && !isText(openFile.name)) return;
		setFileLoading(true);
		try {
			const res = await wsFetch(
				`/api/wiki/content?path=${encodeURIComponent(openFile.path)}`,
			);
			if (res.ok) {
				const d: { content: string } = await res.json();
				setFileContent(d.content);
				setFileRevision(Number(res.headers.get("X-Wiki-Revision") ?? 0));
			}
		} catch {
			/* ignore */
		}
		setFileLoading(false);
	}, [openFile]);

	// Unified refresh: reload text/markdown content and remount binary viewers.
	const handleRefresh = useCallback(() => {
		setViewerKey((k) => k + 1);
		void refreshViewer();
	}, [refreshViewer]);

	useEffect(() => {
		if (!openFile || !isMarkdown(openFile.name)) return;
		if (useEditorStore.getState().currentPath === openFile.path) return;
		void useEditorStore.getState().loadPage(openFile.path);
	}, [openFile]);

	// Keep watcher refs in sync
	useEffect(() => {
		openFileRef.current = openFile;
	}, [openFile]);
	useEffect(() => {
		editingRef.current = editing;
	}, [editing]);
	useEffect(() => {
		refreshViewerRef.current = refreshViewer;
	}, [refreshViewer]);

	// File watcher: auto-update tree + open file via SSE
	useEffect(() => {
		if (!rootConfigured) return;

		const pendingReloads = new Map<string, ReturnType<typeof setTimeout>>();

		function scheduleReload(dir: string) {
			if (pendingReloads.has(dir)) clearTimeout(pendingReloads.get(dir)!);
			pendingReloads.set(
				dir,
				setTimeout(() => {
					pendingReloads.delete(dir);
					void reloadDir(dir);
				}, 300),
			);
		}

		const es = new EventSource(withWs("/api/wiki/watch"));

		es.onmessage = (event) => {
			let data: { type: string; path: string };
			try {
				data = JSON.parse(event.data as string) as {
					type: string;
					path: string;
				};
			} catch {
				return;
			}
			const { type, path: relPath } = data;

			// Reload the affected parent dir in the tree
			const parts = relPath.split("/");
			const parentDir =
				parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			scheduleReload(parentDir);

			// If the open file changed externally and we're not editing, refresh it
			if (
				type === "change" &&
				openFileRef.current?.path === relPath &&
				!editingRef.current
			) {
				const key = `__file__${relPath}`;
				if (pendingReloads.has(key)) clearTimeout(pendingReloads.get(key)!);
				pendingReloads.set(
					key,
					setTimeout(() => {
						pendingReloads.delete(key);
						void refreshViewerRef.current();
					}, 400),
				);
			}
		};

		return () => {
			es.close();
			for (const t of pendingReloads.values()) clearTimeout(t);
		};
	}, [rootConfigured, reloadDir]);

	async function toggleFolder(node: TreeNode) {
		if (node.type !== "dir" && node.type !== "app" && node.type !== "node-app") return;
		if (!node.expanded) {
			if (node.children === undefined) {
				const prefetched = await takePrefetchedDir(node.path);
				if (prefetched) {
					setRoots((prev) =>
						updateNodes(prev, node.path, (n) => ({
							...n,
							loading: false,
							children: prefetched,
							expanded: true,
						})),
					);
					return;
				}
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({ ...n, loading: true })),
				);
				const children = await fetchDir(node.path);
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({
						...n,
						loading: false,
						children,
						expanded: true,
					})),
				);
			} else {
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({ ...n, expanded: true })),
				);
			}
		} else {
			setRoots((prev) =>
				updateNodes(prev, node.path, (n) => ({ ...n, expanded: false })),
			);
		}
	}

	useEffect(() => {
		setAppFullscreen(false);
	}, []);

	async function openViewer(node: TreeNode) {
		// Push to recent files (only real files, not dirs/apps)
		if (node.type === "file") {
			useRecentStore.getState().push(
				{ path: node.path, name: node.name },
				activeWorkspaceId,
			);
		}
		setOpenFile({
			path: node.path,
			name: node.name,
			size: node.size,
			nodeType:
				node.type === "app"
					? "app"
					: node.type === "node-app"
					? "node-app"
					: "file",
		});
		setEditing(false);
		setHtmlSourceMode(false);
		setSaveError(null);
		setFileContent(null);
		setFileRevision(0);
		if (node.type === "file" && isMarkdown(node.name)) {
			setFileLoading(true);
			try {
				await useEditorStore.getState().loadPage(node.path);
			} finally {
				setFileLoading(false);
			}
			return;
		}
		const kind = viewerKindFor(node.name, node.type);
		if (!["editor", "text"].includes(kind) && !isText(node.name)) return;
		setFileLoading(true);
		try {
			const res = await wsFetch(
				`/api/wiki/content?path=${encodeURIComponent(node.path)}`,
			);
			if (res.ok) {
				const d: { content: string } = await res.json();
				setFileContent(d.content);
				setFileRevision(Number(res.headers.get("X-Wiki-Revision") ?? 0));
			}
		} catch {
			/* ignore */
		}
		setFileLoading(false);
	}

	// Open a file from a search result: reveal it in the tree, then open it.
	const openFromSearch = useCallback(
		(relPath: string) => {
			const name = relPath.split("/").pop() ?? relPath;
			void revealPath(relPath);
			void openViewer({ path: relPath, name, type: "file" } as TreeNode);
		},
		[revealPath],
	);

	const openPinnedEntry = useCallback(
		async (p: PinnedEntry) => {
			const parentDir = p.path.split("/").slice(0, -1).join("/");
			const siblings = await fetchDir(parentDir);
			const match = siblings.find((s) => s.path === p.path);
			if (!match) return;
			if (match.type === "dir") {
				await revealPath(p.path);
				await toggleFolder(match);
				return;
			}
			if (match.type === "app" || match.type === "node-app") {
				await revealPath(match.path);
				void openViewer({ path: match.path, name: match.name, type: match.type, modifiedAt: match.modifiedAt } as TreeNode);
				await toggleFolder(match);
				if (isMobile) setSidebarCollapsed(true);
				return;
			}
			void openViewer({ path: match.path, name: match.name, type: match.type, modifiedAt: match.modifiedAt } as TreeNode);
			if (isMobile) setSidebarCollapsed(true);
		},
		[isMobile, openViewer, revealPath, toggleFolder],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: only react to editor path changes
	useEffect(() => {
		if (!editorCurrentPath) return;
		if (openFile && openFile.path === editorCurrentPath) return;
		const name = editorCurrentPath.split("/").pop() ?? editorCurrentPath;
		void openViewer({
			path: editorCurrentPath,
			name,
			type: "file",
		} as TreeNode);
	}, [editorCurrentPath]);

	// Open a file (or clear the viewer) from a workspace-relative path.
	// Resolves node type from the parent dir listing (file vs app vs node-app).
	// biome-ignore lint/correctness/useExhaustiveDependencies: openViewer is a hoisted stable fn
	const navigateToPath = useCallback(
		async (target: string | null) => {
			if (!target) {
				setOpenFile(null);
				return;
			}
			const parts = target.split("/");
			const name = parts[parts.length - 1];
			const parentDir = parts.slice(0, -1).join("/");
			const siblings = await fetchDir(parentDir);
			const match = siblings.find((s) => s.path === target);
			if (!match) return; // file no longer exists; leave current view
			await revealPath(target);
			void openViewer({
				path: target,
				name,
				type: match.type,
				modifiedAt: match.modifiedAt,
			} as TreeNode);
		},
		[revealPath],
	);

	// Persist the open file to the URL (?path=) so reloads restore it and the
	// browser back/forward buttons can move between files. pushState creates a
	// history entry per switch; the guard skips no-op writes (e.g. popstate-driven
	// openFile changes where the URL already matches), avoiding duplicate entries.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const url = new URL(window.location.href);
		if (openFile) url.searchParams.set("path", openFile.path);
		else url.searchParams.delete("path");
		const next = url.toString();
		if (next === window.location.href) return;
		window.history.pushState(null, "", next);
	}, [openFile]);

	// React to browser back/forward: open the file named in the new URL.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onPop = () => {
			const p = new URLSearchParams(window.location.search).get("path");
			void navigateToPath(p);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [navigateToPath]);

	// Restore the open file from the URL once the root tree is loaded.
	useEffect(() => {
		if (didRestoreRef.current) return;
		if (!rootLoaded) return;
		didRestoreRef.current = true;
		void navigateToPath(initialUrlPathRef.current);
	}, [rootLoaded, navigateToPath]);

	const switchWorkspace = useCallback(async (id: string) => {
		if (id === activeWorkspaceId) return;
		try {
			await fetch(`/api/system/workspaces/${id}/open`, { method: "POST" });
		} catch {
			/* best-effort lastOpened bump */
		}
		const u = new URL(location.href);
		u.searchParams.set("ws", id);
		u.searchParams.delete("path");
		history.pushState(null, "", u.toString());
		// Reset open file + caches; the key={activeWorkspaceId} remount clears the rest.
		setOpenFile(null);
		setFileContent(null);
		setEditing(false);
		setRoots([]);
		setRootLoaded(false);
		rootLoadingRef.current = false;
		useWikiSlugsStore.getState().invalidate();
		const ws = workspaces.find((w) => w.id === id);
		if (ws) setRootPath(ws.rootDir);
		setActiveWorkspaceId(id);
	}, [activeWorkspaceId, workspaces]);

	const handleDeleteWorkspace = useCallback(async () => {
		if (!deletingWorkspaceId) return;
		try {
			const res = await fetch(`/api/system/workspaces/${deletingWorkspaceId}`, {
				method: "DELETE",
			});
			if (!res.ok) throw new Error("Failed");
			// If deleting the active workspace, switch to first available or picker
			if (deletingWorkspaceId === activeWorkspaceId) {
				const remaining = workspaces.filter((w) => w.id !== deletingWorkspaceId);
				if (remaining.length > 0) {
					const next = [...remaining].sort(
						(a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)
					)[0];
					await switchWorkspace(next.id);
				} else {
					setRootConfigured(false);
				}
			}
			await loadWorkspaces();
		} catch {
			/* ignore */
		} finally {
			setDeletingWorkspaceId(null);
		}
	}, [deletingWorkspaceId, activeWorkspaceId, workspaces, switchWorkspace, loadWorkspaces]);

	const handleRefreshWorkspace = useCallback(async (id: string) => {
		if (refreshingWsId) return;
		setRefreshingWsId(id);
		try {
			const res = await fetch(`/api/system/workspaces/${id}/refresh`, { method: "POST" });
			if (!res.ok) {
				const e: { error?: string } = await res.json();
				showError(e.error ?? "Refresh failed");
			}
			await loadWorkspaces();
		} catch {
			showError("Refresh failed");
		} finally {
			setRefreshingWsId(null);
		}
	}, [refreshingWsId, loadWorkspaces]);

	const loadWsBranches = useCallback(async (id: string) => {
		if (wsBranches[id]) return;
		try {
			const res = await fetch(`/api/system/workspaces/${id}/branch`);
			if (!res.ok) return;
			const d: { branches?: string[] } = await res.json();
			setWsBranches((prev) => ({ ...prev, [id]: d.branches ?? [] }));
		} catch { /* ignore */ }
	}, [wsBranches]);

	const handleSwitchBranch = useCallback(async (id: string, branch: string) => {
		if (switchingBranch) return;
		setSwitchingBranch(id);
		setSwitchingBranchName(branch);
		try {
			const res = await fetch(`/api/system/workspaces/${id}/branch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ branch }),
			});
			if (!res.ok) {
				const e: { error?: string } = await res.json();
				showError(e.error ?? "Branch switch failed");
				return;
			}
			showSuccess(`Switched to ${branch}`);
			setBranchPickerWsId(null);
			setWsBranchPos(null);
			await loadWorkspaces();
		} catch {
			showError("Branch switch failed");
		} finally {
			setSwitchingBranch(null);
			setSwitchingBranchName(null);
		}
	}, [switchingBranch, loadWorkspaces]);

	async function handleSave() {
		if (!openFile) return;
		setSaving(true);
		setSaveError(null);
		const res = await wsFetch("/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: openFile.path,
				content: editContent,
				baseRevision: fileRevision,
			}),
		});
		if (res.ok) {
			const d: { revision?: number } = await res.json();
			if (typeof d.revision === "number") setFileRevision(d.revision);
			setFileContent(editContent);
			setEditing(false);
		} else {
			const e: { error?: string } = await res.json();
			setSaveError(e.error ?? "Save failed");
		}
		setSaving(false);
	}

	const doUpload = useCallback(
		async (files: FileList | File[], dir: string) => {
			const list = Array.from(files);
			if (!list.length) return;
			setUploading(true);
			setUploadError(null);
			try {
				for (const file of list) {
					const fd = new FormData();
					fd.append("file", file);
					fd.append("dir", dir);
					const res = await wsFetch("/api/wiki/upload", {
						method: "POST",
						body: fd,
					});
					if (!res.ok) {
						const e: { error?: string } = await res.json();
						setUploadError(e.error ?? "Upload failed");
						showError(e.error ?? "Upload failed");
						break;
					}
				}
				await reloadDir(dir);
			} catch {
				setUploadError("Upload failed.");
			} finally {
				setUploading(false);
				if (fileInputRef.current) fileInputRef.current.value = "";
			}
		},
		[reloadDir],
	);

	function triggerUpload(dir: string) {
		uploadDirRef.current = dir;
		fileInputRef.current?.click();
	}

	async function handleCreateFolder() {
		const name = newFolderName.trim();
		if (!name || newFolderParent === null) return;
		setFolderError(null);
		const rel = newFolderParent ? `${newFolderParent}/${name}` : name;
		const res = await wsFetch("/api/wiki/folder", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: rel }),
		});
		if (res.ok) {
			setNewFolderParent(null);
			setNewFolderName("");
			await reloadDir(newFolderParent);
			if (newFolderParent !== "") {
				setRoots((prev) =>
					updateNodes(prev, newFolderParent, (n) => ({ ...n, expanded: true })),
				);
			}
		} else {
			const e: { error?: string } = await res.json();
			setFolderError(e.error ?? "Failed");
		}
	}

	async function handleCreateFile() {
		const raw = newFileName.trim();
		if (!raw || newFileParent === null) return;
		setFileCreateError(null);
		const name = raw.includes(".") ? raw : `${raw}.md`;
		const rel = newFileParent ? `${newFileParent}/${name}` : name;
		const res = await wsFetch("/api/wiki/new-file", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: rel }),
		});
		if (res.ok) {
			const parent = newFileParent;
			setNewFileParent(null);
			setNewFileName("");
			await reloadDir(parent);
			if (parent !== "") {
				setRoots((prev) =>
					updateNodes(prev, parent, (n) => ({ ...n, expanded: true })),
				);
			}
			void openViewer({
				path: rel,
				name,
				type: "file",
				modifiedAt: new Date().toISOString(),
			} as TreeNode);
		} else {
			const e: { error?: string } = await res.json();
			setFileCreateError(e.error ?? "Failed");
		}
	}

	function handleDownload(node: TreeNode) {
		const url = withWs(`/api/wiki/download?path=${encodeURIComponent(node.path)}`);
		const a = document.createElement("a");
		a.href = url;
		a.download = node.type === "file" ? node.name : `${node.name}.zip`;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function copyPath(path: string) {
		void navigator.clipboard.writeText(path);
		showSuccess("Path copied");
	}

	function copyWikiLink(name: string) {
		const slug = name.replace(/\.(md|markdown)$/i, "");
		void navigator.clipboard.writeText(`[[${slug}]]`);
		showSuccess("Wiki link copied");
	}

	function copyUrl(path: string) {
		const url = new URL(location.href);
		url.searchParams.set("path", path);
		if (activeWorkspaceId) url.searchParams.set("ws", activeWorkspaceId);
		void navigator.clipboard.writeText(url.toString());
		showSuccess("URL copied");
	}

	async function getTextContent(path: string) {
		if (openFile?.path === path && fileContent !== null) return fileContent;
		if (useEditorStore.getState().currentPath === path) {
			return useEditorStore.getState().content;
		}
		const res = await wsFetch(`/api/wiki/content?path=${encodeURIComponent(path)}`);
		if (!res.ok) throw new Error("Cannot copy content");
		const data: { content: string } = await res.json();
		return data.content;
	}

	async function copyRawContent(path: string) {
		try {
			const content = await getTextContent(path);
			await navigator.clipboard.writeText(content);
			showSuccess("Raw content copied");
		} catch {
			showError("Could not copy file content");
		}
	}

	async function copyFormattedContent(path: string, name: string) {
		try {
			const content = await getTextContent(path);
			if (!isMarkdown(name)) {
				await navigator.clipboard.writeText(content);
				showSuccess("Content copied");
				return;
			}
			const html = await markdownToHtml(content, { pagePath: path, sanitize: true });
			if ("ClipboardItem" in window && navigator.clipboard.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([html], { type: "text/html" }),
						"text/plain": new Blob([content], { type: "text/plain" }),
					}),
				]);
			} else {
				await navigator.clipboard.writeText(content);
			}
			showSuccess("Formatted content copied");
		} catch {
			showError("Could not copy formatted content");
		}
	}

	function renderCopyMenu(node: { path: string; name: string }) {
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 gap-1.5 px-2 text-xs"
						title="Copy path, wiki link, or URL"
					>
						<Copy className="h-3.5 w-3.5" />
						Copy
						<ChevronDown className="h-3 w-3 opacity-60" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					<DropdownMenuItem onClick={() => copyPath(node.path)}>
						<Copy className="mr-2 h-3.5 w-3.5" />
						Copy path
					</DropdownMenuItem>
					{isMarkdown(node.name) && (
						<DropdownMenuItem onClick={() => copyWikiLink(node.name)}>
							<FileText className="mr-2 h-3.5 w-3.5" />
							Copy wiki link
						</DropdownMenuItem>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => copyUrl(node.path)}>
						<Link className="mr-2 h-3.5 w-3.5" />
						Copy URL
					</DropdownMenuItem>
					{isText(node.name) && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={() => void copyRawContent(node.path)}>
								<FileText className="mr-2 h-3.5 w-3.5" />
								Copy raw content
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => void copyFormattedContent(node.path, node.name)}>
								<FileText className="mr-2 h-3.5 w-3.5" />
								Copy formatted content
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	async function handleDelete() {
		if (!deletingPath) return;
		await wsFetch("/api/wiki", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: deletingPath }),
		});
		if (
			openFile?.path === deletingPath ||
			openFile?.path.startsWith(`${deletingPath}/`)
		) {
			setOpenFile(null);
			setFileContent(null);
		}
		setRoots((prev) => removeNode(prev, deletingPath));
		setDeletingPath(null);
	}

	function handleDragStart(e: React.DragEvent, node: TreeNode) {
		dragNodeRef.current = node;
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", node.path);
	}

	function handleDragOver(
		e: React.DragEvent,
		targetPath: string,
		targetType: "dir" | "root",
	) {
		e.preventDefault();
		e.stopPropagation();
		const dragging = dragNodeRef.current;
		if (!dragging) {
			// External OS file drag: allow copy-upload into this folder.
			if (Array.from(e.dataTransfer.types).includes("Files")) {
				e.dataTransfer.dropEffect = "copy";
				setDragOverPath(targetType === "root" ? "" : targetPath);
			}
			return;
		}
		if (
			dragging.path === targetPath ||
			targetPath.startsWith(`${dragging.path}/`)
		)
			return;
		e.dataTransfer.dropEffect = "move";
		setDragOverPath(targetType === "root" ? "" : targetPath);
	}

	async function handleDropOnFolder(e: React.DragEvent, targetDirPath: string) {
		e.preventDefault();
		e.stopPropagation();
		setDragOverPath(null);
		const node = dragNodeRef.current;
		dragNodeRef.current = null;
		if (!node) {
			// External OS file drop: upload into the target folder.
			if (e.dataTransfer.files.length > 0)
				await doUpload(e.dataTransfer.files, targetDirPath);
			return;
		}
		if (
			node.path === targetDirPath ||
			targetDirPath.startsWith(`${node.path}/`)
		)
			return;

		const newPath = targetDirPath ? `${targetDirPath}/${node.name}` : node.name;
		if (newPath === node.path) return;

		const res = await wsFetch("/api/wiki/move", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: node.path, to: newPath }),
		});
		if (res.ok) {
			const sourceParent = node.path.includes("/")
				? node.path.split("/").slice(0, -1).join("/")
				: "";
			await reloadDir(sourceParent);
			if (targetDirPath !== sourceParent) await reloadDir(targetDirPath);
			if (openFile?.path === node.path)
				setOpenFile({
					path: newPath,
					name: node.name,
					nodeType: openFile.nodeType,
					size: openFile.size,
				});
		}
	}

	const openFileViewerKind = openFile
		? viewerKindFor(openFile.name, openFile.nodeType)
		: null;

	// Gate everything not explicitly safe. Markdown ("editor") is gated too:
	// TipTap builds a node per block and freezes on big docs.
	const showLargeFileGate =
		!!openFile &&
		openFileViewerKind !== null &&
		!SAFE_VIEWER_KINDS.has(openFileViewerKind) &&
		(openFile.size ?? 0) > LARGE_FILE_GATE_BYTES &&
		gateBypassPath !== openFile.path;

	const viewWidth = useViewWidthStore((s) => s.width);
	const viewAlign = useViewWidthStore((s) => s.align);
	// Width toggle only meaningful for text-flow viewers (long prose lines).
	const widthAwareViewer =
		openFileViewerKind === null ||
		openFileViewerKind === "editor" ||
		openFileViewerKind === "text" ||
		openFileViewerKind === "source" ||
		openFileViewerKind === "notebook" ||
		openFileViewerKind === "fallback";
	const contentWidthClass = widthAwareViewer ? VIEW_WIDTH_CLASS[viewWidth] : "";
	const contentAlignClass = widthAwareViewer ? VIEW_ALIGN_CLASS[viewAlign] : "";

	// Ref-backed dispatcher: handlers below are recreated each render, but the
	// dispatcher methods are referentially stable, so FileTree's React.memo holds.
	const treeHandlersRef = useRef<TreeCtx | null>(null);
	treeHandlersRef.current = {
		toggleFolder: (n) => void toggleFolder(n),
		openViewer: (n) => void openViewer(n),
		copyPath,
		copyWikiLink,
		copyUrl,
		copyRawContent: (path) => void copyRawContent(path),
		copyFormattedContent: (path, name) => void copyFormattedContent(path, name),
		handleDownload,
		triggerUpload,
		handleCreateFile: () => void handleCreateFile(),
		handleCreateFolder: () => void handleCreateFolder(),
		handleDragStart,
		handleDragOver,
		handleDropOnFolder: (e, p) => void handleDropOnFolder(e, p),
		handleGitPull: (p, d) => void handleGitPull(p, d),
		handleCheckout: (p, b, d) => void handleCheckout(p, b, d),
		loadBranches: (p) => void loadBranches(p),
		prefetch: (node) => {
			if (node.type === "file") { if (isMarkdown(node.name)) prefetchPage(node.path); }
			else prefetchDir(node.path);
		},
		togglePin: (node, wsId) =>
					usePinStore.getState().toggle(
						{ path: node.path, name: node.name, type: node.type },
						wsId,
					),
		setDragOverPath,
		setSidebarCollapsed,
		setBranchDropdownNode,
		setBranchDropdownPos,
		setNewFileParent,
		setNewFileName,
		setFileCreateError,
		setNewFolderParent,
		setNewFolderName,
		setFolderError,
		setDeletingPath,
		setDeletingIsDir,
	};
	const treeCtx = useMemo<TreeCtx>(() => {
		const r = treeHandlersRef;
		return {
			toggleFolder: (n) => r.current!.toggleFolder(n),
			openViewer: (n) => r.current!.openViewer(n),
			copyPath: (p) => r.current!.copyPath(p),
			copyWikiLink: (n) => r.current!.copyWikiLink(n),
			copyUrl: (p) => r.current!.copyUrl(p),
			copyRawContent: (p) => r.current!.copyRawContent(p),
			copyFormattedContent: (p, n) => r.current!.copyFormattedContent(p, n),
			handleDownload: (n) => r.current!.handleDownload(n),
			triggerUpload: (d) => r.current!.triggerUpload(d),
			handleCreateFile: () => r.current!.handleCreateFile(),
			handleCreateFolder: () => r.current!.handleCreateFolder(),
			handleDragStart: (e, n) => r.current!.handleDragStart(e, n),
			handleDragOver: (e, p, t) => r.current!.handleDragOver(e, p, t),
			handleDropOnFolder: (e, p) => r.current!.handleDropOnFolder(e, p),
			handleGitPull: (p, d) => r.current!.handleGitPull(p, d),
			handleCheckout: (p, b, d) => r.current!.handleCheckout(p, b, d),
			loadBranches: (p) => r.current!.loadBranches(p),
			prefetch: (n) => r.current!.prefetch(n),
			togglePin: (n, w) => r.current!.togglePin(n, w),
			setDragOverPath: (p) => r.current!.setDragOverPath(p),
			setSidebarCollapsed: (b) => r.current!.setSidebarCollapsed(b),
			setBranchDropdownNode: (p) => r.current!.setBranchDropdownNode(p),
			setBranchDropdownPos: (p) => r.current!.setBranchDropdownPos(p),
			setNewFileParent: (p) => r.current!.setNewFileParent(p),
			setNewFileName: (s) => r.current!.setNewFileName(s),
			setFileCreateError: (s) => r.current!.setFileCreateError(s),
			setNewFolderParent: (p) => r.current!.setNewFolderParent(p),
			setNewFolderName: (s) => r.current!.setNewFolderName(s),
			setFolderError: (s) => r.current!.setFolderError(s),
			setDeletingPath: (p) => r.current!.setDeletingPath(p),
			setDeletingIsDir: (b) => r.current!.setDeletingIsDir(b),
		};
	}, []);

	return (
		<div key={activeWorkspaceId ?? "none"} className="flex h-screen gap-0 overflow-hidden bg-background">
			{rootConfigured === null && (
				<div className="flex-1 flex items-center justify-center">
					<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			)}
			{rootConfigured === false && (
				<DirPicker onSelect={(workspaceId) => {
					const u = new URL(location.href);
					u.searchParams.set("ws", workspaceId);
					u.searchParams.delete("path");
					history.replaceState(null, "", u.toString());
					setRootLoaded(false);
					rootLoadingRef.current = false;
					setActiveWorkspaceId(workspaceId);
					setRootConfigured(true);
					void loadWorkspaces();
				}} />
			)}
			{rootConfigured === true && addingWorkspace && (
				<div className="flex-1 flex flex-col">
					<div className="flex items-center justify-end border-b px-3 py-2 bg-muted shrink-0">
						<Button size="sm" variant="ghost" className="h-7 gap-1.5 text-xs" onClick={() => setAddingWorkspace(false)}>
							<X className="h-3.5 w-3.5" /> Cancel
						</Button>
					</div>
					<DirPicker onSelect={(workspaceId) => {
						setAddingWorkspace(false);
						void loadWorkspaces();
						void switchWorkspace(workspaceId);
					}} />
				</div>
			)}
			{rootConfigured === true && !addingWorkspace && <>
			<SearchCommandDialog
				onOpenFile={openFromSearch}
				onToggleSidebar={() =>
				setSidebarCollapsed((v) => {
					const next = !v;
					if (isMobile && next === false) useAIPanelStore.getState().close();
					return next;
				})
			}
				onNewFile={() => setNewFileParent("")}
				onCopyPath={() => {
					if (openFile) void navigator.clipboard.writeText(openFile.path);
				}}
			/>
			{/* Tree sidebar */}
			{!sidebarCollapsed && isMobile && (
				<div
					className="fixed inset-0 z-40 bg-overlay backdrop-blur-[1px] md:hidden"
					onClick={() => setSidebarCollapsed(true)}
					aria-hidden
				/>
			)}
			{!sidebarCollapsed && (
				<Card
					style={isMobile ? undefined : { width: sidebarWidth }}
					className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[20rem] md:relative md:z-auto md:w-auto md:max-w-none flex flex-col shrink-0 overflow-hidden rounded-none border-r border-l-0 border-t-0 border-b-0">
					{/* Row 1: brand + collapse */}
					<div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted shrink-0">
						<div className="flex min-w-0 items-center gap-1.5">
							<img src="/logo.svg" alt="Wiki Viewer" className="h-5 w-5 shrink-0" />
							<span className="truncate text-xs font-semibold leading-5 tracking-tight translate-y-[0.5px]">
								Wiki Viewer
							</span>
						</div>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0 shrink-0"
							title="Collapse sidebar"
							onClick={() => setSidebarCollapsed(true)}
						>
							<PanelLeftClose className="h-3.5 w-3.5" />
						</Button>
					</div>

					{/* Row 2: actions toolbar */}
					<div className="flex items-center justify-between gap-1 px-3 py-1.5 border-b bg-muted/50 shrink-0">
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									size="sm"
									variant="ghost"
									className="h-7 gap-1 px-2 text-xs"
									disabled={uploading}
								>
									{uploading ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Plus className="h-3.5 w-3.5" />
									)}
									New
									<ChevronDown className="h-3 w-3 opacity-60" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-44">
								<DropdownMenuItem
									onClick={() => {
										setNewFileParent("");
										setNewFileName("");
										setFileCreateError(null);
									}}
								>
									<FilePlus className="mr-2 h-3.5 w-3.5" />
									New file
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => {
										setNewFolderParent("");
										setNewFolderName("");
										setFolderError(null);
									}}
								>
									<FolderPlus className="mr-2 h-3.5 w-3.5" />
									New folder
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => triggerUpload("")}
									disabled={uploading}
								>
									<Upload className="mr-2 h-3.5 w-3.5" />
									Upload
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>

						<div className="flex items-center gap-0.5">
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="Refresh tree"
								onClick={refreshTree}
								disabled={refreshingTree}
							>
								{refreshingTree ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<RefreshCw className="h-3.5 w-3.5" />
								)}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title={showHidden ? "Hide hidden files" : "Show hidden files"}
								onClick={() => useShowHiddenStore.getState().toggle()}
							>
								{showHidden ? (
									<Eye className="h-3.5 w-3.5" />
								) : (
									<EyeOff className="h-3.5 w-3.5" />
								)}
							</Button>
							<ThemeToggle />
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="AI Agent panel"
								onClick={() => {
									useAIPanelStore.getState().toggle();
									if (isMobile) setSidebarCollapsed(true);
								}}
							>
								<Bot className="h-3.5 w-3.5" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="Settings"
								onClick={() => setSettingsOpen(true)}
							>
								<Settings className="h-3.5 w-3.5" />
							</Button>
						</div>
					</div>

					{uploadError && (
						<div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive bg-destructive/10 shrink-0">
							<AlertCircle className="h-3.5 w-3.5 shrink-0" />
							{uploadError}
						</div>
					)}

					{newFolderParent === "" && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0">
							<Folder className="h-4 w-4 shrink-0 text-warning" />
							<input
								className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
								placeholder="Folder name"
								value={newFolderName}
								onChange={(e) => setNewFolderName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreateFolder();
									if (e.key === "Escape") {
										setNewFolderParent(null);
										setNewFolderName("");
									}
								}}
							/>
							{folderError && (
								<span className="text-xs text-destructive">{folderError}</span>
							)}
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								onClick={handleCreateFolder}
							>
								<Check className="h-3 w-3" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								onClick={() => {
									setNewFolderParent(null);
									setNewFolderName("");
								}}
							>
								<X className="h-3 w-3" />
							</Button>
						</div>
					)}

					{newFileParent === "" && (
						<div className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0">
							<FileText className="h-4 w-4 shrink-0 text-accent" />
							<input
								autoFocus
								className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
								placeholder="filename (default .md)"
								value={newFileName}
								onChange={(e) => setNewFileName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") handleCreateFile();
									if (e.key === "Escape") {
										setNewFileParent(null);
										setNewFileName("");
									}
								}}
							/>
							{fileCreateError && (
								<span className="text-xs text-destructive">{fileCreateError}</span>
							)}
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								onClick={handleCreateFile}
							>
								<Check className="h-3 w-3" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 w-6 p-0"
								onClick={() => {
									setNewFileParent(null);
									setNewFileName("");
								}}
							>
								<X className="h-3 w-3" />
							</Button>
						</div>
					)}

					<div className="border-b">
						<SidebarSearchBox onOpenFile={openFromSearch} />
					</div>

					<div
						ref={sidebarScrollRef}
						className={cn(
							"flex-1 overflow-auto py-1 editorial-file-tree",
							dragOverPath === "" &&
								"ring-2 ring-inset ring-primary bg-primary/5",
						)}
						onDragOver={(e) => handleDragOver(e, "", "root")}
						onDragLeave={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget as Node))
								setDragOverPath(null);
						}}
						onDrop={(e) => handleDropOnFolder(e, "")}
					>
						{/* Pinned section */}
						{pins.length > 0 && (
							<div className="border-b mb-1">
								<button
									type="button"
									className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
									onClick={() => setPinnedCollapsed((c) => !c)}
								>
									{pinnedCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
									<Pin className="h-3 w-3" />
									Pinned
									<span className="ml-auto text-[9px] tabular-nums opacity-60">{pins.length}</span>
								</button>
								{!pinnedCollapsed && pins.map((p) => (
									<ContextMenu key={p.path}>
										<ContextMenuTrigger asChild>
									<div
										role="button"
										tabIndex={0}
										className={cn(
											"group flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors select-none",
											openFile?.path === p.path ? "bg-accent-soft text-foreground font-medium" : "hover:bg-muted",
										)}
										onClick={() => { void openPinnedEntry(p); }}
										onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openPinnedEntry(p); } }}
									>
										<FileTypeIcon name={p.name} type={(p.type ?? "file") as TreeNode["type"]} />
										<span className="min-w-0 flex-1 truncate text-xs">{p.name}</span>
										<span className="max-w-[80px] truncate text-[10px] text-muted-foreground/60">{p.path.split("/").slice(0, -1).join("/")}</span>
										<button
											type="button"
											className="hover-reveal shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:bg-muted hover:text-amber-400 group-hover:opacity-100 focus:opacity-100"
											title="Remove from pinned"
											onClick={(e) => {
												e.stopPropagation();
												usePinStore
													.getState()
													.toggle({ path: p.path, name: p.name }, activeWorkspaceId);
											}}
										>
											<X className="h-3 w-3" />
										</button>
									</div>
										</ContextMenuTrigger>
										<FileContextMenuItems
											node={{ path: p.path, name: p.name, type: (p.type ?? "file") as TreeNode["type"] } as TreeNode}
											ctx={treeCtx}
											isPinned={true}
											activeWorkspaceId={activeWorkspaceId}
										/>
									</ContextMenu>
								))}
							</div>
						)}
						{/* Recent files section */}
						{recents.length > 0 && (
							<div className="border-b mb-1">
								<button
									type="button"
									className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
									onClick={() => setRecentCollapsed((c) => !c)}
								>
									{recentCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
									<History className="h-3 w-3" />
									Recent
									<span className="ml-auto text-[9px] tabular-nums opacity-60">{recents.length}</span>
								</button>
								{!recentCollapsed && recents.slice(0, 8).map((r) => (
									<ContextMenu key={r.path}>
										<ContextMenuTrigger asChild>
									<div
										role="button"
										tabIndex={0}
										className={cn(
											"flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors select-none",
											openFile?.path === r.path ? "bg-accent-soft text-foreground font-medium" : "hover:bg-muted",
										)}
										onClick={() => { void openViewer({ path: r.path, name: r.name, type: (r.type ?? "file") as TreeNode["type"], modifiedAt: "" } as TreeNode); if (isMobile) setSidebarCollapsed(true); }}
										onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openViewer({ path: r.path, name: r.name, type: (r.type ?? "file") as TreeNode["type"], modifiedAt: "" } as TreeNode); } }}
									>
										<FileTypeIcon name={r.name} type={(r.type ?? "file") as TreeNode["type"]} />
										<span className="flex-1 truncate text-xs">{r.name}</span>
										<span className="text-[10px] text-muted-foreground/60 truncate max-w-[80px]">{r.path.split("/").slice(0, -1).join("/")}</span>
									</div>
										</ContextMenuTrigger>
										<FileContextMenuItems
											node={{ path: r.path, name: r.name, type: (r.type ?? "file") as TreeNode["type"] } as TreeNode}
											ctx={treeCtx}
											isPinned={pins.some((pin) => pin.path === r.path)}
											activeWorkspaceId={activeWorkspaceId}
										/>
									</ContextMenu>
								))}
							</div>
						)}
						{rootLoading ? (
							<div className="flex justify-center py-6">
								<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
							</div>
						) : roots.length === 0 ? (
							<div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
								<div className="rounded-full bg-muted p-3">
									<FileText className="h-6 w-6 text-muted-foreground" />
								</div>
								<div className="space-y-1">
									<p className="text-sm font-medium">No files yet</p>
									<p className="text-xs text-muted-foreground">
										Upload files or add them to the configured directory
									</p>
								</div>
								<Button
									size="sm"
									variant="outline"
									className="w-full gap-1.5 max-w-[180px]"
									onClick={() => triggerUpload("")}
									disabled={uploading}
								>
									{uploading ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Upload className="h-3.5 w-3.5" />
									)}
									Upload Files
								</Button>
							</div>
						) : (
							<FileTree
								ctx={treeCtx}
								nodes={roots}
								openPath={openFile?.path ?? null}
								dragOverPath={dragOverPath}
								branchDropdownNode={branchDropdownNode}
								branchDropdownPos={branchDropdownPos}
								nodeBranches={nodeBranches}
								branchesLoading={branchesLoading}
								checkingOutBranch={checkingOutBranch}
								pullingRepo={pullingRepo}
								activePaths={activePaths}
								pins={pins}
								isMobile={isMobile}
								activeWorkspaceId={activeWorkspaceId}
								newFileParent={newFileParent}
								newFileName={newFileName}
								fileCreateError={fileCreateError}
								newFolderParent={newFolderParent}
								newFolderName={newFolderName}
								folderError={folderError}
								sidebarScrollRef={sidebarScrollRef}
							/>
						)}
					</div>
					<div className="border-t px-2 py-2 bg-muted shrink-0">
						<DropdownMenu modal={false} onOpenChange={(o) => { if (!o) { setBranchPickerWsId(null); setWsBranchPos(null); } }}>
							<DropdownMenuTrigger asChild>
								<Button
									size="sm"
									variant="ghost"
									className="w-full h-auto justify-between gap-2 px-2 py-1.5 text-left"
									title={rootPath ?? ""}
								>
									<span className="flex flex-col min-w-0">
										<span className="truncate text-xs font-medium">
											{workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? "Workspace"}
										</span>
										<span className="truncate text-[10px] text-muted-foreground font-mono">
											{rootPath ?? ""}
										</span>
									</span>
									<ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]" onInteractOutside={(e) => { if ((e.target as HTMLElement | null)?.closest?.("[data-branch-portal]")) e.preventDefault(); }}>
								{workspaces.map((w) => (
									<DropdownMenuItem
										key={w.id}
										onClick={() => void switchWorkspace(w.id)}
										onPointerMove={(e) => e.preventDefault()}
										onPointerLeave={(e) => e.preventDefault()}
										className={cn("gap-2", w.id === activeWorkspaceId && "font-medium")}
									>
										{w.id === activeWorkspaceId ? (
											<Check className="h-3.5 w-3.5 shrink-0" />
										) : (
											<span className="w-3.5 shrink-0" />
										)}
										<span className="flex flex-col min-w-0 flex-1">
											<span className="flex items-center gap-1.5 truncate">
												<span className="truncate">{w.name}</span>
												{w.git ? (
													isWsAdmin ? (
								<button
									data-branch-trigger
									type="button"
															className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0 hover:bg-accent"
															title="Switch branch"
															disabled={switchingBranch === w.id}
																					onClick={(e) => {
																						e.stopPropagation();
																						e.preventDefault();
																						if (branchPickerWsId === w.id) { setBranchPickerWsId(null); setWsBranchPos(null); return; }
																					const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
																					setWsBranchPos({ top: rect.bottom + 4, left: rect.left });
																					setBranchPickerWsId(w.id);
																					void loadWsBranches(w.id);
																				}}
														>
															<GitBranch className="h-2.5 w-2.5" /> {w.git.branch ?? "branch"}
														</button>
													) : (
														<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
															<GitBranch className="h-2.5 w-2.5" /> {w.git.branch ?? "read-only"}
														</span>
													)
												) : w.ssh ? (
													<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
														<Server className="h-2.5 w-2.5" /> {w.ssh.host}
													</span>
												) : w.readOnly ? (
													<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
														<GitBranch className="h-2.5 w-2.5" /> read-only
													</span>
												) : null}
											</span>
											<span className="truncate text-[10px] text-muted-foreground font-mono">{w.rootDir}</span>
											{w.git?.lastPulledAt && timeAgo(w.git.lastPulledAt) && (
												<span className="text-[10px] text-muted-foreground/70">synced {timeAgo(w.git.lastPulledAt)}</span>
											)}
											{/* branch picker rendered standalone below, outside the menu's focus scope */}
										</span>
										{isWsAdmin && w.git && (
											<button
												className={cn(
													"shrink-0 rounded p-0.5 hover:bg-accent transition-colors",
													w.git.lastError ? "text-destructive" : "text-muted-foreground hover:text-foreground",
												)}
												title={w.git.lastError ? `Last refresh failed: ${w.git.lastError}` : "Refresh"}
												disabled={refreshingWsId === w.id}
												onClick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													void handleRefreshWorkspace(w.id);
												}}
											>
												<RefreshCw className={cn("h-3.5 w-3.5", refreshingWsId === w.id && "animate-spin")} />
											</button>
										)}
										{isWsAdmin && (
											<button
												className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
												title="Delete workspace (does not delete files)"
												onClick={(e) => {
													e.stopPropagation();
													setDeletingWorkspaceId(w.id);
												}}
											>
												<Trash2 className="h-3.5 w-3.5" />
											</button>
										)}
									</DropdownMenuItem>
								))}
								{isWsAdmin && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem onClick={() => setAddingWorkspace(true)}>
											<FolderPlus className="mr-2 h-3.5 w-3.5" />
											Add workspace…
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
						{(() => {
							if (!branchPickerWsId || !wsBranchPos) return null;
							const w = workspaces.find((x) => x.id === branchPickerWsId);
							if (!w) return null;
							return (
								<BranchDropdown
									pos={wsBranchPos}
									branches={(wsBranches[w.id] ?? []).map((b) => ({ name: b, current: b === w.git?.branch }))}
									loading={!wsBranches[w.id]}
									busyName={switchingBranch === w.id ? switchingBranchName : null}
									disabled={switchingBranch === w.id}
									onPick={(name) => { void handleSwitchBranch(w.id, name); }}
									onClose={() => { setBranchPickerWsId(null); setWsBranchPos(null); }}
								/>
							);
						})()}
					</div>
					{/* Resize handle */}
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize sidebar"
						title="Drag to resize"
						onMouseDown={(e) => {
							e.preventDefault();
							const startX = e.clientX;
							const startW = sidebarWidth;
							setSidebarResizing(true);
							const prevCursor = document.body.style.cursor;
							const prevSelect = document.body.style.userSelect;
							document.body.style.cursor = "col-resize";
							document.body.style.userSelect = "none";
							const onMove = (ev: MouseEvent) => {
								setSidebarWidth(startW + (ev.clientX - startX));
							};
							const onUp = () => {
								setSidebarResizing(false);
								document.body.style.cursor = prevCursor;
								document.body.style.userSelect = prevSelect;
								window.removeEventListener("mousemove", onMove);
								window.removeEventListener("mouseup", onUp);
							};
							window.addEventListener("mousemove", onMove);
							window.addEventListener("mouseup", onUp);
						}}
						onDoubleClick={() => setSidebarWidth(288)}
						onKeyDown={(e) => {
							if (e.key === "ArrowLeft") {
								e.preventDefault();
								setSidebarWidth(sidebarWidth - 16);
							} else if (e.key === "ArrowRight") {
								e.preventDefault();
								setSidebarWidth(sidebarWidth + 16);
							}
						}}
						tabIndex={0}
						aria-valuemin={SIDEBAR_MIN_WIDTH}
						aria-valuemax={SIDEBAR_MAX_WIDTH}
						aria-valuenow={sidebarWidth}
						className={cn(
							"absolute right-0 top-0 z-20 h-full w-1.5 cursor-col-resize -mr-px transition-colors hover:bg-primary/40 focus:bg-primary/40 focus:outline-none hidden md:block",
							sidebarResizing && "bg-primary/60",
						)}
					/>
				</Card>
			)}

			{/* Right panel */}
			<div className="flex-1 flex flex-col min-w-0 relative">
				{/* Desktop: floating reopen button when sidebar is collapsed */}
				{sidebarCollapsed && (
					<Button
						size="sm"
						variant="ghost"
						className="hidden md:flex absolute left-2 top-2 z-10 h-7 w-7 p-0"
						title="Show sidebar"
						onClick={() => setSidebarCollapsed(false)}
					>
						<PanelLeftOpen className="h-3.5 w-3.5" />
					</Button>
				)}
				{/* Mobile: dedicated top bar hosting the drawer + AI panel toggles */}
				<div className="md:hidden flex h-11 shrink-0 items-center justify-between gap-2 border-b bg-muted px-1">
					<Button
						size="sm"
						variant="ghost"
						className="h-9 w-9 p-0"
						title="Show sidebar"
						onClick={() => {
							setSidebarCollapsed(false);
							useAIPanelStore.getState().close();
						}}
					>
						<PanelLeftOpen className="h-4 w-4" />
					</Button>
					<span
						className="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-tight text-muted-foreground"
						title={openFile?.path}
					>
						{openFile && (
							<span className="editorial-tree-typeicon shrink-0">
								{openFileViewerKind === "app" || openFileViewerKind === "html" ? (
									<Globe className="h-4 w-4 text-foreground/70" />
								) : isImage(openFile.name) ? (
									<ImageIcon className="h-4 w-4 text-sunshine-700" />
								) : isText(openFile.name) ? (
									<FileText className="h-4 w-4 text-foreground/70" />
								) : (
									<File className="h-4 w-4 text-foreground/60" />
								)}
							</span>
						)}
						<span className="truncate">
							{openFile ? openFile.name : "Wiki Viewer"}
						</span>
					</span>
					<Button
						size="sm"
						variant="ghost"
						className="h-9 w-9 p-0"
						title="AI Agent panel"
						onClick={() => {
							useAIPanelStore.getState().open();
							setSidebarCollapsed(true);
						}}
					>
						<Bot className="h-4 w-4" />
					</Button>
				</div>
				{openFile ? (
					openFileViewerKind === "node-app" ? (
						<NodeAppViewer path={openFile.path} title={openFile.name} />
					) : (openFileViewerKind === "app" || openFileViewerKind === "html") ? (
						// html files → direct asset URL; app folders → index.html (default)
						(() => {
							const websiteSrc =
								openFileViewerKind === "html"
									? `/api/assets/${openFile.path}`
									: undefined;
							return appFullscreen ? (
								<WebsiteViewer
									path={openFile.path}
									title={openFile.name}
									src={websiteSrc}
									fullscreen
									onExit={() => setAppFullscreen(false)}
								/>
							) : (
								<div className="flex-1 flex flex-col overflow-hidden min-w-0">
									<div className={cn("flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0 editorial-doc-header", !isMobile && sidebarCollapsed && "pl-11")}>
										<div className="flex items-center gap-2 min-w-0">
											<span className="hidden md:inline-flex">
												<span className="editorial-tree-typeicon">
													<Globe className="h-4 w-4 shrink-0 text-foreground/70" />
												</span>
											</span>
											<span
												className="hidden md:inline text-sm font-normal truncate"
												title={openFile.path}
											>
												{openFile.path}
											</span>
										</div>
										<div className="flex items-center gap-1 shrink-0">
											{renderCopyMenu(openFile)}
											{openFileViewerKind === "html" &&
												!editing &&
												fileContent !== null && (
													<Button
														size="sm"
														variant="ghost"
														className="h-7 w-7 p-0"
														title="Edit source"
														onClick={() => {
															setEditing(true);
															setEditContent(fileContent);
															setSaveError(null);
														}}
													>
														<Pencil className="h-3.5 w-3.5" />
													</Button>
											)}
											{openFileViewerKind === "html" && !editing && (
												<Button
													size="sm"
													variant="ghost"
													className="h-7 gap-1.5 text-xs"
													title={htmlSourceMode ? "Show rendered page" : "Show source (with comments)"}
													onClick={() => setHtmlSourceMode((v) => !v)}
												>
													{htmlSourceMode ? <Globe className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
													{htmlSourceMode ? "Preview" : "Source"}
												</Button>
											)}
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												title="Refresh"
												onClick={() => setAppKey((k) => k + 1)}
											>
												<RefreshCw className="h-3.5 w-3.5" />
											</Button>
											<Button
												size="sm"
												variant="ghost"
												className="h-7 gap-1.5 text-xs"
												onClick={() => setAppFullscreen(true)}
											>
												<Maximize2 className="h-3.5 w-3.5" />
												Open fullscreen
											</Button>
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												onClick={() => {
													setOpenFile(null);
													setEditing(false);
												}}
											>
												<X className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
									{editing && openFileViewerKind === "html" ? (
										<div className="flex-1 flex flex-col overflow-hidden min-h-0">
											<textarea
												value={editContent}
												onChange={(e) => setEditContent(e.target.value)}
												spellCheck={false}
												className="flex-1 w-full min-h-0 resize-none bg-background text-foreground px-4 py-3 font-mono text-[13px] leading-relaxed outline-none border-0"
											/>
											<div className="border-t px-4 py-2 flex items-center justify-end gap-2 bg-muted shrink-0">
												{saveError && (
													<span className="text-xs text-destructive mr-auto">
														{saveError}
													</span>
												)}
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setEditing(false);
														setSaveError(null);
													}}
												>
													Cancel
												</Button>
												<Button
													size="sm"
													className="gap-1"
													onClick={handleSave}
													disabled={saving}
												>
													{saving && (
														<Loader2 className="h-3 w-3 animate-spin" />
													)}
													Save
												</Button>
											</div>
										</div>
									) : htmlSourceMode && openFileViewerKind === "html" ? (
										<SourceViewer path={openFile.path} title={openFile.name} />
									) : (
										<WebsiteViewer
											key={appKey}
											path={openFile.path}
											title={openFile.name}
											src={websiteSrc}
										/>
									)}
								</div>
							);
						})()
					) : (
						<div className="flex-1 flex flex-col overflow-hidden min-w-0">
							<div className={cn("flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0 editorial-doc-header", !isMobile && sidebarCollapsed && "pl-11")}>
								<div className="flex items-center gap-2 min-w-0">
									<span className="hidden md:inline-flex"><span className="editorial-tree-typeicon">
										{isImage(openFile.name) ? (
											<ImageIcon className="h-4 w-4 shrink-0 text-sunshine-700" />
										) : isText(openFile.name) ? (
											<FileText className="h-4 w-4 shrink-0 text-foreground/70" />
										) : (
											<File className="h-4 w-4 shrink-0 text-foreground/60" />
										)}
									</span></span>
									<span
										className="hidden md:inline text-sm font-normal truncate"
										title={openFile.path}
									>
										{openFile.path}
									</span>
									{gitFileInfo && (
										<span className="hidden md:flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 ml-1">
											<User className="h-3 w-3 shrink-0" />
											<span className="truncate max-w-[100px]">{gitFileInfo.author}</span>
											<span title={new Date(gitFileInfo.date).toLocaleString()} className="shrink-0">{timeAgo(gitFileInfo.date)}</span>
										</span>
									)}
								</div>
								<div className="flex items-center gap-1 shrink-0">
									{renderCopyMenu(openFile)}
									<Button
										size="sm"
										variant="ghost"
										className="h-7 w-7 p-0"
										title="File history"
										onClick={() => { if (showHistory) setShowHistory(false); else void loadHistory(); }}
									>
										<History className="h-3.5 w-3.5" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="h-7 w-7 p-0"
										title="Share"
										onClick={() => setShareDialogOpen(true)}
									>
										<Share className="h-3.5 w-3.5" />
									</Button>
									{isText(openFile.name) &&
										!editing &&
										(fileContent !== null || isMarkdown(openFile.name)) && (
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												onClick={() => {
													setEditing(true);
													setEditContent(fileContent ?? "");
													setSaveError(null);
													if (isMarkdown(openFile.name)) {
														void useEditorStore
															.getState()
															.loadPage(openFile.path);
													}
												}}
											>
												<Pencil className="h-3.5 w-3.5" />
											</Button>
										)}
									{isText(openFile.name) &&
										editing &&
										isMarkdown(openFile.name) && (
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												title="Done editing"
												onClick={() => {
													setEditing(false);
													setSaveError(null);
												}}
											>
												<Eye className="h-3.5 w-3.5" />
											</Button>
										)}
									{!editing && (
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												title="Refresh"
												onClick={handleRefresh}
												disabled={fileLoading}
											>
												{fileLoading ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : (
													<RefreshCw className="h-3.5 w-3.5" />
												)}
											</Button>
										)}
									{widthAwareViewer && <ViewWidthToggle />}
									<Button
										size="sm"
										variant="ghost"
										className="h-7 w-7 p-0"
										onClick={() => {
											setOpenFile(null);
											setFileContent(null);
											setEditing(false);
										}}
									>
										<X className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>

							{/* History panel */}
							{showHistory && (
								<div className="border-b bg-muted/30 shrink-0 max-h-[40vh] overflow-auto">
									<div className="flex items-center justify-between px-4 py-1.5 border-b">
										<span className="text-xs font-semibold text-muted-foreground">History</span>
										<button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setShowHistory(false)}>
											<X className="h-3.5 w-3.5" />
										</button>
									</div>
									{historyLoading ? (
										<div className="flex justify-center py-4">
											<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
										</div>
									) : historyCommits.length === 0 ? (
										<p className="px-4 py-3 text-xs text-muted-foreground">No history found.</p>
									) : (
										<div>
											{historyCommits.map((c) => (
												<div key={c.sha}>
													<button
														type="button"
														className={cn(
															"w-full text-left px-4 py-2 hover:bg-muted transition-colors",
															selectedDiffSha === c.sha && "bg-muted",
														)}
														onClick={() => void selectDiff(c.sha)}
													>
														<div className="flex items-center gap-2">
															<code className="text-[11px] font-mono text-muted-foreground shrink-0">{c.shortSha}</code>
															<span className="flex-1 truncate text-xs">{c.message}</span>
															<span className="shrink-0 text-[11px] text-muted-foreground">{c.author}</span>
															<span className="shrink-0 text-[11px] text-muted-foreground" title={new Date(c.date).toLocaleString()}>{timeAgo(c.date)}</span>
														</div>
													</button>
													{selectedDiffSha === c.sha && (
														<div className="border-t">
															{diffLoading ? (
																<div className="flex justify-center py-3">
																	<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
																</div>
															) : diffContent !== null ? (
																<pre className="overflow-auto px-4 py-2 text-[11px] font-mono leading-relaxed whitespace-pre text-foreground/80 max-h-60">{diffContent}</pre>
															) : null}
														</div>
													)}
												</div>
											))}
										</div>
									)}
								</div>
							)}

							{showLargeFileGate ? (
								<LargeFileGate
									path={openFile.path}
									size={openFile.size ?? 0}
									onOpen={() => setGateBypassPath(openFile.path)}
								/>
							) : editing ? (
								<div className="flex-1 flex flex-col overflow-hidden min-h-0">
									{isMarkdown(openFile.name) ? (
										<KBEditor />
									) : (
										<textarea
											value={editContent}
											onChange={(e) => setEditContent(e.target.value)}
											spellCheck={false}
											className="flex-1 w-full min-h-0 resize-none bg-background text-foreground px-4 py-3 font-mono text-[13px] leading-relaxed outline-none border-0"
										/>
									)}
								</div>
							) : isMarkdown(openFile.name) ? (
								<div className="flex-1 flex flex-col overflow-hidden min-h-0">
									{fileLoading ? (
										<div className="flex justify-center py-8">
											<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
										</div>
									) : (
										<KBEditor mode="viewing" />
									)}
								</div>
							) : openFileViewerKind === "csv" ||
								openFileViewerKind === "pdf" ||
								openFileViewerKind === "mermaid" ||
								openFileViewerKind === "notebook" ||
								openFileViewerKind === "image" ||
								openFileViewerKind === "media" ||
								openFileViewerKind === "docx" ||
								openFileViewerKind === "xlsx" ||
								openFileViewerKind === "pptx" ||
								openFileViewerKind === "source" ||
								openFileViewerKind === "fallback" ? (
								<div key={viewerKey} className="flex-1 flex flex-col overflow-hidden min-h-0">
									{fileLoading ? (
										<div className="flex justify-center py-8">
											<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
										</div>
									) : openFileViewerKind === "csv" ? (
										<CsvViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "pdf" ? (
										<PdfViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "mermaid" ? (
										<MermaidViewer
											path={openFile.path}
											title={openFile.name}
										/>
									) : openFileViewerKind === "notebook" ? (
										<NotebookViewer
											path={openFile.path}
											title={openFile.name}
										/>
									) : openFileViewerKind === "image" ? (
										<ImageViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "media" ? (
										<MediaViewer
											path={openFile.path}
											title={openFile.name}
											type={
											["mp4", "webm", "mov", "m4v"].includes(
												ext(openFile.name),
											)
												? "video"
												: "audio"
											}
										/>
									) : openFileViewerKind === "docx" ? (
										<DocxViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "xlsx" ? (
										<XlsxViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "pptx" ? (
										<PptxViewer path={openFile.path} title={openFile.name} />
									) : openFileViewerKind === "source" ? (
										<SourceViewer
											path={openFile.path}
											title={openFile.name}
										/>
									) : (
										<FileFallbackViewer
											path={openFile.path}
											title={openFile.name}
										/>
									)}
								</div>
							) : (
								<div className="flex-1 overflow-auto p-4 min-h-0">
									<div className={cn("w-full", contentAlignClass, contentWidthClass)}>
									{fileLoading ? (
										<div className="flex justify-center py-8">
											<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
										</div>
									) : fileContent !== null ? (
										<pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
											{fileContent}
										</pre>
									) : isText(openFile.name) ? (
										<p className="text-sm text-muted-foreground">
											Could not load file.
										</p>
									) : (
										<p className="text-sm text-muted-foreground">
											Preview not available for this file type.
										</p>
									)}
									</div>
								</div>
							)}

							{editing && !isMarkdown(openFile.name) && (
								<div className="border-t px-4 py-2 flex items-center justify-end gap-2 bg-muted shrink-0">
									{saveError && (
										<span className="text-xs text-destructive mr-auto">
											{saveError}
										</span>
									)}
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setEditing(false);
											setSaveError(null);
										}}
									>
										Cancel
									</Button>
									<Button
										size="sm"
										className="gap-1"
										onClick={handleSave}
										disabled={saving}
									>
										{saving && <Loader2 className="h-3 w-3 animate-spin" />}
										Save
									</Button>
								</div>
							)}
						</div>
					)
				) : (
					<div className="flex-1 flex flex-col items-center justify-center">
						<div className="flex flex-col items-center gap-2 text-center px-4">
							<FileText className="h-8 w-8 text-muted-foreground" />
							<p className="text-sm text-muted-foreground">
								Select a file to view or edit
							</p>
						</div>
					</div>
				)}
			</div>

			<ShareDialog
				open={shareDialogOpen}
				onOpenChange={setShareDialogOpen}
				filePath={openFile?.path ?? ""}
			/>
			<AuthSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
			<AIPanel currentPath={openFile?.path} />
			<input
				ref={fileInputRef}
				type="file"
				multiple
				className="hidden"
				onChange={(e) => {
					if (e.target.files) doUpload(e.target.files, uploadDirRef.current);
				}}
			/>

			<ConfirmDialog
				open={!!deletingPath}
				onOpenChange={(open) => {
					if (!open) setDeletingPath(null);
				}}
				title={deletingIsDir ? "Delete folder?" : "Delete file?"}
				description={
					deletingIsDir
						? `"${deletingPath?.split("/").pop()}" and all its contents will be permanently deleted.`
						: `"${deletingPath?.split("/").pop()}" will be permanently removed.`
				}
				onConfirm={handleDelete}
			/>

			<ConfirmDialog
				open={!!deletingWorkspaceId}
				onOpenChange={(open) => {
					if (!open) setDeletingWorkspaceId(null);
				}}
				title="Delete workspace?"
				description={`"${workspaces.find((w) => w.id === deletingWorkspaceId)?.name ?? ""}" will be removed from the workspace list. Files on disk are NOT deleted.`}
				onConfirm={handleDeleteWorkspace}
			/>
			</>}
		</div>
	);
}
