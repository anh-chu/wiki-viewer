"use client";

import {
	AlertCircle,
	Check,
	ChevronDown,
	ChevronRight,
	File,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	Globe,
	Image as ImageIcon,
	Loader2,
	Maximize2,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	RefreshCw,
	Terminal,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CsvViewer } from "@/components/editor/csv-viewer";
import { KBEditor } from "@/components/editor/editor";
import { FileFallbackViewer } from "@/components/editor/file-fallback-viewer";
import { ImageViewer } from "@/components/editor/image-viewer";
import { MediaViewer } from "@/components/editor/media-viewer";
import { MermaidViewer } from "@/components/editor/mermaid-viewer";
import { NotebookViewer } from "@/components/editor/notebook-viewer";
import { DocxViewer } from "@/components/editor/office/docx-viewer";
import { PptxViewer } from "@/components/editor/office/pptx-viewer";
import { XlsxViewer } from "@/components/editor/office/xlsx-viewer";
import { PdfViewer } from "@/components/editor/pdf-viewer";
import { SourceViewer } from "@/components/editor/source-viewer";
import { WebsiteViewer } from "@/components/editor/website-viewer";
import { NodeAppViewer } from "@/components/editor/node-app-viewer";
import { DirPicker } from "@/components/dir-picker";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FrontmatterHeader } from "@/components/wiki/frontmatter-header";
import { parseFrontmatter } from "@/lib/markdown/parse-frontmatter";
import remarkWikilinks from "@/lib/markdown/remark-wikilinks";
import { showError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor-store";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";

interface TreeNode {
	name: string;
	path: string;
	type: "dir" | "file" | "app" | "node-app";
	size?: number;
	modifiedAt: string;
	children?: TreeNode[];
	expanded?: boolean;
	loading?: boolean;
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
	const fileExt = ext(filename);
	if (!fileExt) return "fallback";
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
	return "fallback";
}

function isText(name: string) {
	const kind = viewerKindFor(name, "file");
	return kind === "editor" || kind === "text";
}
function isImage(name: string) {
	return viewerKindFor(name, "file") === "image";
}
function isHtmlFile(name: string) {
	return viewerKindFor(name, "file") === "html";
}

async function fetchDir(dir: string): Promise<TreeNode[]> {
	const res = await fetch(`/api/wiki?dir=${encodeURIComponent(dir)}`);
	if (!res.ok) return [];
	const data: {
		entries: Array<{
			name: string;
			type: "dir" | "file" | "app";
			size?: number;
			modifiedAt: string;
		}>;
	} = await res.json();
	return data.entries.map((e) => ({
		name: e.name,
		path: dir ? `${dir}/${e.name}` : e.name,
		type: e.type,
		size: e.size,
		modifiedAt: e.modifiedAt,
		expanded: false,
	}));
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

export default function Page() {
	const slugsLoadedAt = useWikiSlugsStore((s) => s.loadedAt);
	useEffect(() => {
		void useWikiSlugsStore.getState().load();
	}, []);
	void slugsLoadedAt;

	// null = checking, false = not set, true = ready
	const [rootConfigured, setRootConfigured] = useState<boolean | null>(null);

	useEffect(() => {
		fetch("/api/system/root-status")
			.then((r) => r.json())
			.then((d: { configured: boolean }) => setRootConfigured(d.configured))
			.catch(() => setRootConfigured(false));
	}, []);

	const editorCurrentPath = useEditorStore((s) => s.currentPath);

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

	const [deletingPath, setDeletingPath] = useState<string | null>(null);
	const [deletingIsDir, setDeletingIsDir] = useState(false);

	const [openFile, setOpenFile] = useState<{
		path: string;
		name: string;
		nodeType: "file" | "app" | "node-app";
	} | null>(null);
	const [appFullscreen, setAppFullscreen] = useState(false);
	const [appKey, setAppKey] = useState(0);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [fileLoading, setFileLoading] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
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

	const reloadDir = useCallback(async (dir: string) => {
		const fresh = await fetchDir(dir);
		if (dir === "") {
			setRoots(fresh);
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

	const collectExpandedPaths = useCallback((nodes: TreeNode[]): string[] => {
		const paths: string[] = [];
		for (const n of nodes) {
			if ((n.type === "dir" || n.type === "app") && n.expanded && n.children) {
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
		const kind = viewerKindFor(openFile.name, openFile.nodeType);
		if (!["editor", "text"].includes(kind)) return;
		setFileLoading(true);
		try {
			const res = await fetch(
				`/api/wiki/content?path=${encodeURIComponent(openFile.path)}`,
			);
			if (res.ok) {
				const d: { content: string } = await res.json();
				setFileContent(d.content);
			}
		} catch {
			/* ignore */
		}
		setFileLoading(false);
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

		const es = new EventSource("/api/wiki/watch");

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
		if (node.type !== "dir" && node.type !== "app") return;
		if (!node.expanded) {
			if (node.children === undefined) {
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
		setOpenFile({
			path: node.path,
			name: node.name,
			nodeType:
				node.type === "app"
					? "app"
					: node.type === "node-app"
					? "node-app"
					: "file",
		});
		setEditing(false);
		setSaveError(null);
		setFileContent(null);
		const kind = viewerKindFor(node.name, node.type);
		if (!["editor", "text"].includes(kind)) return;
		setFileLoading(true);
		try {
			const res = await fetch(
				`/api/wiki/content?path=${encodeURIComponent(node.path)}`,
			);
			if (res.ok) {
				const d: { content: string } = await res.json();
				setFileContent(d.content);
			}
		} catch {
			/* ignore */
		}
		setFileLoading(false);
	}

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

	async function handleSave() {
		if (!openFile) return;
		setSaving(true);
		setSaveError(null);
		const res = await fetch("/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: openFile.path, content: editContent }),
		});
		if (res.ok) {
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
					const res = await fetch("/api/wiki/upload", {
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
		const res = await fetch("/api/wiki/folder", {
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

	async function handleDelete() {
		if (!deletingPath) return;
		await fetch("/api/wiki", {
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
		if (!dragging) return;
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
		if (!node) return;
		if (
			node.path === targetDirPath ||
			targetDirPath.startsWith(`${node.path}/`)
		)
			return;

		const newPath = targetDirPath ? `${targetDirPath}/${node.name}` : node.name;
		if (newPath === node.path) return;

		const res = await fetch("/api/wiki/move", {
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
				});
		}
	}

	const openFileViewerKind = openFile
		? viewerKindFor(openFile.name, openFile.nodeType)
		: null;

	function renderNodes(nodes: TreeNode[], depth = 0): React.ReactNode {
		return nodes.map((node) => (
			<div key={node.path}>
				<div
					role="treeitem"
					tabIndex={0}
					draggable
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							if (node.type === "dir") toggleFolder(node);
							else if (node.type === "app") { openViewer(node); toggleFolder(node); }
							else openViewer(node);
						}
					}}
					onDragStart={(e) => handleDragStart(e, node)}
					onDragOver={(e) =>
						node.type === "dir"
							? handleDragOver(e, node.path, "dir")
							: e.preventDefault()
					}
					onDragLeave={() => setDragOverPath(null)}
					onDrop={(e) =>
						node.type === "dir"
							? handleDropOnFolder(e, node.path)
							: e.preventDefault()
					}
					className={cn(
						"flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer group transition-colors select-none",
						openFile?.path === node.path
							? "bg-accent text-accent-foreground"
							: "hover:bg-accent/50",
						dragOverPath === node.path && "ring-2 ring-primary bg-primary-soft",
						node.name.startsWith(".") && "opacity-40",
					)}
					style={{ paddingLeft: `${depth * 14 + 8}px` }}
					onClick={() => {
						if (node.type === "dir") toggleFolder(node);
						else if (node.type === "app") { openViewer(node); toggleFolder(node); }
						else openViewer(node);
					}}
				>
					{(node.type === "dir" || node.type === "app") ? (
						node.loading ? (
							<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
						) : node.expanded ? (
							<ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						)
					) : (
						<span className="w-3.5 shrink-0" />
					)}

					{node.type === "dir" ? (
						node.expanded ? (
							<FolderOpen className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-warning")} />
						) : (
							<Folder className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-warning")} />
						)
					) : node.type === "app" ? (
						<Globe className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-accent")} />
					) : node.type === "node-app" ? (
						<Terminal className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-emerald-500")} />
					) : isHtmlFile(node.name) ? (
						<Globe className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-accent/70")} />
					) : isImage(node.name) ? (
						<ImageIcon className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-sunshine-700")} />
					) : isText(node.name) ? (
						<FileText className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-accent")} />
					) : (
						<File className={cn("h-4 w-4 shrink-0", openFile?.path !== node.path && "text-muted-foreground")} />
					)}

					<span className="flex-1 truncate">{node.name}</span>

					<div
						className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						{node.type === "dir" && (
							<>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
									title="Upload here"
									onClick={() => triggerUpload(node.path)}
								>
									<Upload className="h-3 w-3" />
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
									title="New subfolder"
									onClick={() => {
										setNewFolderParent(node.path);
										setNewFolderName("");
										setFolderError(null);
									}}
								>
									<FolderPlus className="h-3 w-3" />
								</Button>
							</>
						)}
						<Button
							size="sm"
							variant="ghost"
							className="h-6 w-6 p-0 text-destructive hover:text-destructive"
							title="Delete"
							onClick={() => {
								setDeletingPath(node.path);
								setDeletingIsDir(node.type !== "file");
							}}
						>
							<Trash2 className="h-3 w-3" />
						</Button>
					</div>
				</div>

				{newFolderParent === node.path && node.type === "dir" && (
					<div
						className="flex items-center gap-1.5 px-2 py-1"
						style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
					>
						<span className="w-3.5 shrink-0" />
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

				{(node.type === "dir" || node.type === "app") &&
					node.expanded &&
					node.children &&
					node.children.length > 0 &&
					renderNodes(node.children, depth + 1)}
				{(node.type === "dir" || node.type === "app") &&
					node.expanded &&
					node.children?.length === 0 && (
						<div
							className="text-xs text-muted-foreground/50 py-0.5"
							style={{
								paddingLeft: `${(depth + 1) * 14 + 8 + 14 + 6 + 16 + 6}px`,
							}}
						>
							Empty
						</div>
					)}
			</div>
		));
	}

	return (
		<div className="flex h-screen gap-0 overflow-hidden bg-background">
			{rootConfigured === null && (
				<div className="flex-1 flex items-center justify-center">
					<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			)}
			{rootConfigured === false && (
				<DirPicker onSelect={() => {
					setRootLoaded(false);
					rootLoadingRef.current = false;
					setRootConfigured(true);
				}} />
			)}
			{rootConfigured === true && <>
			{/* Tree sidebar */}
			{!sidebarCollapsed && (
				<Card className="flex flex-col w-72 shrink-0 overflow-hidden rounded-none border-r border-l-0 border-t-0 border-b-0">
					<div className="flex items-center justify-between px-3 py-2 border-b bg-muted shrink-0">
						<span className="text-xs font-medium text-muted-foreground">
							Files
						</span>
						<div className="flex items-center gap-1">
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
								title="New root folder"
								onClick={() => {
									setNewFolderParent("");
									setNewFolderName("");
									setFolderError(null);
								}}
							>
								<FolderPlus className="h-3.5 w-3.5" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="Upload to root"
								onClick={() => triggerUpload("")}
								disabled={uploading}
							>
								{uploading ? (
									<Loader2 className="h-3.5 w-3.5 animate-spin" />
								) : (
									<Upload className="h-3.5 w-3.5" />
								)}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="Collapse sidebar"
								onClick={() => setSidebarCollapsed(true)}
							>
								<PanelLeftClose className="h-3.5 w-3.5" />
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

					<div
						className={cn(
							"flex-1 overflow-auto py-1",
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
							renderNodes(roots)
						)}
					</div>
				</Card>
			)}

			{/* Right panel */}
			<div className="flex-1 flex flex-col min-w-0 relative">
				{sidebarCollapsed && (
					<Button
						size="sm"
						variant="ghost"
						className="absolute left-0 top-1/2 -translate-y-1/2 z-10 h-7 w-7 p-0 rounded-full bg-background/50 backdrop-blur-xl backdrop-saturate-150 border border-white/[0.08] text-foreground/60 hover:text-foreground/90 hover:bg-background/70 shadow-[0_0_12px_rgba(0,0,0,0.15)] [transform:translate(-50%,-50%)_translateZ(0)]"
						title="Show sidebar"
						onClick={() => setSidebarCollapsed(false)}
					>
						<PanelLeftOpen className="h-3.5 w-3.5" />
					</Button>
				)}
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
									<div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
										<div className="flex items-center gap-2 min-w-0">
											<Globe className="h-4 w-4 shrink-0 text-accent" />
											<span
												className="text-sm font-normal truncate"
												title={openFile.path}
											>
												{openFile.path}
											</span>
										</div>
										<div className="flex items-center gap-1 shrink-0">
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
												onClick={() => setOpenFile(null)}
											>
												<X className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
									<WebsiteViewer
										key={appKey}
										path={openFile.path}
										title={openFile.name}
										src={websiteSrc}
									/>
								</div>
							);
						})()
					) : (
						<div className="flex-1 flex flex-col overflow-hidden min-w-0">
							<div className="flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0">
								<div className="flex items-center gap-2 min-w-0">
									{isImage(openFile.name) ? (
										<ImageIcon className="h-4 w-4 shrink-0 text-sunshine-700" />
									) : isText(openFile.name) ? (
										<FileText className="h-4 w-4 shrink-0 text-accent" />
									) : (
										<File className="h-4 w-4 shrink-0 text-muted-foreground" />
									)}
									<span
										className="text-sm font-normal truncate"
										title={openFile.path}
									>
										{openFile.path}
									</span>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									{isText(openFile.name) &&
										!editing &&
										fileContent !== null && (
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												onClick={() => {
													setEditing(true);
													setEditContent(fileContent);
													setSaveError(null);
													void useEditorStore
														.getState()
														.loadPage(openFile.path);
												}}
											>
												<Pencil className="h-3.5 w-3.5" />
											</Button>
										)}
									{isText(openFile.name) &&
										!editing &&
										fileContent !== null && (
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												title="Refresh"
												onClick={refreshViewer}
												disabled={fileLoading}
											>
												{fileLoading ? (
													<Loader2 className="h-3.5 w-3.5 animate-spin" />
												) : (
													<RefreshCw className="h-3.5 w-3.5" />
												)}
											</Button>
										)}
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

							{editing ? (
								<div className="flex-1 flex flex-col overflow-hidden min-h-0">
									<KBEditor />
								</div>
							) : (
								<div className="flex-1 overflow-auto p-4 min-h-0">
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
									) : openFileViewerKind === "fallback" ? (
										<FileFallbackViewer
											path={openFile.path}
											title={openFile.name}
										/>
									) : fileContent !== null ? (
										["md", "markdown"].includes(ext(openFile.name)) ? (
											(() => {
												const { data, body } = parseFrontmatter(fileContent);
												return (
													<>
														<FrontmatterHeader
															data={data as Record<string, never>}
														/>
														<ReactMarkdown
															remarkPlugins={[remarkGfm, remarkWikilinks]}
															components={{
																h1: ({ children }) => (
																	<h1 className="text-2xl font-normal mt-6 mb-3 pb-1 border-b">
																		{children}
																	</h1>
																),
																h2: ({ children }) => (
																	<h2 className="text-xl font-normal mt-5 mb-2 pb-1 border-b">
																		{children}
																	</h2>
																),
																h3: ({ children }) => (
																	<h3 className="text-lg font-normal mt-4 mb-2">
																		{children}
																	</h3>
																),
																h4: ({ children }) => (
																	<h4 className="text-base font-normal mt-3 mb-1">
																		{children}
																	</h4>
																),
																p: ({ children }) => (
																	<p className="text-sm leading-relaxed mb-3">
																		{children}
																	</p>
																),
																ul: ({ children }) => (
																	<ul className="list-disc pl-5 mb-3 space-y-1 text-sm">
																		{children}
																	</ul>
																),
																ol: ({ children }) => (
																	<ol className="list-decimal pl-5 mb-3 space-y-1 text-sm">
																		{children}
																	</ol>
																),
																li: ({ children }) => (
																	<li className="leading-relaxed">
																		{children}
																	</li>
																),
																blockquote: ({ children }) => (
																	<blockquote className="border-l-4 border-muted-foreground/30 pl-4 italic text-muted-foreground my-3 text-sm">
																		{children}
																	</blockquote>
																),
																code: ({ className, children, ...props }) => {
																	const isBlock =
																		className?.includes("language-");
																	return isBlock ? (
																		<code
																			className={`block bg-muted rounded-sm px-3 py-2 text-xs font-mono overflow-x-auto my-3 ${className ?? ""}`}
																			{...props}
																		>
																			{children}
																		</code>
																	) : (
																		<code
																			className="bg-muted rounded-sm px-1 py-0.5 text-xs font-mono"
																			{...props}
																		>
																			{children}
																		</code>
																	);
																},
																pre: ({ children }) => (
																	<pre className="my-3 overflow-x-auto">
																		{children}
																	</pre>
																),
																a: ({ href, children, ...rest }) => {
																	const props = rest as Record<
																		string,
																		unknown
																	>;
																	if (props["data-wiki-link"] === "true") {
																		const slug =
																			(props["data-slug"] as string) ?? "";
																		const anchor = props["data-anchor"] as
																			| string
																			| undefined;
																		const broken =
																			slug &&
																			!useWikiSlugsStore
																				.getState()
																				.has(slug);
																		return (
																			<a
																				href={href}
																				className="wiki-link"
																				data-wiki-link="true"
																				data-slug={slug}
																				data-anchor={anchor}
																				data-broken={
																					broken ? "true" : undefined
																				}
																				onClick={(e) => {
																					e.preventDefault();
																					if (!slug) return;
																					const dir = useWikiSlugsStore
																						.getState()
																						.getDir(slug);
																					if (!dir) return;
																					const targetPath =
																						dir === "root"
																							? `${slug}.md`
																							: `${dir}/${slug}.md`;
																					void openViewer({
																						path: targetPath,
																						name: `${slug}.md`,
																						type: "file",
																					} as TreeNode);
																					if (anchor) {
																						setTimeout(() => {
																							document
																								.getElementById(anchor)
																								?.scrollIntoView({
																									behavior: "smooth",
																								});
																						}, 200);
																					}
																				}}
																			>
																				{children}
																			</a>
																		);
																	}
																	return (
																		<a
																			href={href}
																			className="text-primary underline hover:no-underline"
																			target="_blank"
																			rel="noreferrer"
																		>
																			{children}
																		</a>
																	);
																},
																strong: ({ children }) => (
																	<strong className="font-normal">
																		{children}
																	</strong>
																),
																em: ({ children }) => (
																	<em className="italic">{children}</em>
																),
																hr: () => <hr className="my-4 border-border" />,
																table: ({ children }) => (
																	<div className="overflow-x-auto my-3">
																		<table className="w-full text-sm border-collapse">
																			{children}
																		</table>
																	</div>
																),
																th: ({ children }) => (
																	<th className="border border-border px-3 py-1.5 bg-muted font-normal text-left">
																		{children}
																	</th>
																),
																td: ({ children }) => (
																	<td className="border border-border px-3 py-1.5">
																		{children}
																	</td>
																),
															}}
														>
															{body}
														</ReactMarkdown>
													</>
												);
											})()
										) : (
											<pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
												{fileContent}
											</pre>
										)
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
							)}

							{editing && (
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
			</>}
		</div>
	);
}
