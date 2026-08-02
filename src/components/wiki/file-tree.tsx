"use client";

import {
	Check,
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
	Globe,
	Image as ImageIcon,
	Link,
	Loader2,
	MoreHorizontal,
	Pin,
	RefreshCw,
	Terminal,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";

import { BranchDropdown } from "@/components/wiki/branch-dropdown";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useHumanizeStore } from "@/stores/humanize-store";
import { useShowHiddenStore } from "@/stores/show-hidden-store";
import { humanizeName } from "@/lib/humanize-name";
import { prefetchPage } from "@/stores/editor-store";
import { wsFetch } from "@/lib/workspace-client";
import type { FileTreeNode, OpenFile, ViewerKind } from "@/types/wiki";

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

type TreeNode = FileTreeNode;

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

// Max directories we ask the SSE watcher to cover. Mirrors the server's own cap;
// sending more would just be silently dropped there.
const WATCH_DIR_LIMIT = 24;

export function ext(name: string) {
	return name.split(".").pop()?.toLowerCase() ?? "";
}

export function viewerKindFor(
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

export function isText(name: string) {
	const kind = viewerKindFor(name, "file");
	if (kind === "editor" || kind === "text") return true;
	return TEXT_EDITABLE_EXTS.has(ext(name));
}

export function isMarkdown(name: string) {
	return ["md", "markdown"].includes(ext(name));
}
export function isImage(name: string) {
	return viewerKindFor(name, "file") === "image";
}
export function isHtmlFile(name: string) {
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
export interface TreeCtx {
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
export const ROW_CV: React.CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 32px" };

// Shared right-click menu body for any file/dir row (tree, pinned, recent).
export function FileContextMenuItems({
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
				<Pin className={cn("mr-2 h-3.5 w-3.5", isPinned && "fill-current text-amber-400")} />
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
export function FileTypeIcon({ name, type }: { name: string; type: TreeNode["type"] }) {
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
	const humanize = useHumanizeStore((s) => s.humanize);
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

					<span className="min-w-0 flex-1 truncate" title={humanize ? node.name : undefined}>{humanize ? humanizeName(node.name) : node.name}</span>

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
									<Pin className={cn("mr-2 h-3.5 w-3.5", isPinned && "fill-current text-amber-400")} />
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

export const FileTree = memo(function FileTree(p: FileTreeProps) {
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

