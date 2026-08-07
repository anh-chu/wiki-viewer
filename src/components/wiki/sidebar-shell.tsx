"use client";

import type { Dispatch, DragEvent, RefObject, SetStateAction } from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { SearchCommandDialog } from "@/components/search/search-command-dialog";
import { Sidebar } from "@/components/wiki/sidebar";
import type { TreeCtx } from "@/components/wiki/file-tree";
import type { useWorkspaces } from "@/hooks/use-workspaces";
import type { useOpenFile } from "@/hooks/use-open-file";
import type { useUpload } from "@/hooks/use-upload";
import type { FileTreeApi } from "@/hooks/use-file-tree";
import { withWs } from "@/lib/workspace-client";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useFavoriteStore, type FavoriteEntry } from "@/stores/favorite-store";
import type { RecentEntry } from "@/stores/recent-store";
import { useSidebarWidthStore } from "@/stores/sidebar-width-store";
import type { FileTreeNode } from "@/types/wiki";

type TreeNodeAlias = FileTreeNode;

export interface SidebarShellProps {
	workspace: ReturnType<typeof useWorkspaces>;
	doc: ReturnType<typeof useOpenFile>;
	fileTree: FileTreeApi;
	upload: ReturnType<typeof useUpload>;
	isMobile: boolean;
	hideChrome: boolean;
	sidebarCollapsed: boolean;
	setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
	favorites: FavoriteEntry[];
	recents: RecentEntry[];
	activePaths: Set<string>;
	setDeleting: Dispatch<
		SetStateAction<{ path: string | null; isDir: boolean }>
	>;
	setDialogs: Dispatch<
		SetStateAction<{ settingsOpen: boolean; shareDialogOpen: boolean }>
	>;
}

export function SidebarShell({
	workspace,
	doc,
	fileTree,
	upload,
	isMobile,
	hideChrome,
	sidebarCollapsed,
	setSidebarCollapsed,
	favorites,
	recents,
	activePaths,
	setDeleting,
	setDialogs,
}: SidebarShellProps) {
	const [sidebarResizing, setSidebarResizing] = useState(false);
	const [dragOverPath, setDragOverPath] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useState({ favorites: false, recent: true });
	const [createEntry, setCreateEntry] = useState({
		file: {
			parent: null as string | null,
			name: "",
			error: null as string | null,
		},
		folder: {
			parent: null as string | null,
			name: "",
			error: null as string | null,
		},
	});

	const sidebarScrollRef = useRef<HTMLDivElement>(null);
	const dragNodeRef = useRef<TreeNodeAlias | null>(null);

	const sidebarWidth = useSidebarWidthStore((s) => s.width);
	const setSidebarWidth = useSidebarWidthStore((s) => s.setWidth);

	const handleCreateFile = useCallback(async () => {
		const raw = createEntry.file.name.trim();
		if (!raw || createEntry.file.parent === null) return;
		setCreateEntry((prev) => ({
			...prev,
			file: { ...prev.file, error: null },
		}));
		const name = raw.includes(".") ? raw : `${raw}.md`;
		const rel = createEntry.file.parent
			? `${createEntry.file.parent}/${name}`
			: name;
		const res = await fetch(withWs("/api/wiki/new-file"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: rel }),
		});
		if (res.ok) {
			const parent = createEntry.file.parent;
			setCreateEntry((prev) => ({
				...prev,
				file: { parent: null, name: "", error: null },
			}));
			await fileTree.reloadDir(parent);
			void doc.openViewer({
				path: rel,
				name,
				type: "file",
				modifiedAt: new Date().toISOString(),
			} as TreeNodeAlias);
		} else {
			const e: { error?: string } = await res.json();
			setCreateEntry((prev) => ({
				...prev,
				file: { ...prev.file, error: e.error ?? "Failed" },
			}));
		}
	}, [createEntry.file.parent, createEntry.file.name, fileTree, doc]);

	const handleCreateFolder = useCallback(async () => {
		const name = createEntry.folder.name.trim();
		if (!name || createEntry.folder.parent === null) return;
		setCreateEntry((prev) => ({
			...prev,
			folder: { ...prev.folder, error: null },
		}));
		const rel = createEntry.folder.parent
			? `${createEntry.folder.parent}/${name}`
			: name;
		const res = await fetch(withWs("/api/wiki/folder"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: rel }),
		});
		if (res.ok) {
			const parent = createEntry.folder.parent;
			setCreateEntry((prev) => ({
				...prev,
				folder: { parent: null, name: "", error: null },
			}));
			await fileTree.reloadDir(parent);
		} else {
			const e: { error?: string } = await res.json();
			setCreateEntry((prev) => ({
				...prev,
				folder: { ...prev.folder, error: e.error ?? "Failed" },
			}));
		}
	}, [createEntry.folder.parent, createEntry.folder.name, fileTree]);

	function handleDownload(node: TreeNodeAlias) {
		const url = withWs(
			`/api/wiki/download?path=${encodeURIComponent(node.path)}`,
		);
		const a = document.createElement("a");
		a.href = url;
		a.download = node.type === "file" ? node.name : `${node.name}.zip`;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	function handleDragStart(e: DragEvent, node: TreeNodeAlias) {
		dragNodeRef.current = node;
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", node.path);
	}

	function handleDragOver(
		e: DragEvent,
		targetPath: string,
		targetType: "dir" | "root",
	) {
		e.preventDefault();
		e.stopPropagation();
		const dragging = dragNodeRef.current;
		if (!dragging) {
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

	async function handleDropOnFolder(
		e: DragEvent,
		targetDirPath: string,
	) {
		e.preventDefault();
		e.stopPropagation();
		setDragOverPath(null);
		const node = dragNodeRef.current;
		dragNodeRef.current = null;
		if (!node) {
			if (e.dataTransfer.files.length > 0)
				await upload.doUpload(e.dataTransfer.files, targetDirPath);
			return;
		}
		if (
			node.path === targetDirPath ||
			targetDirPath.startsWith(`${node.path}/`)
		)
			return;
		const newPath = targetDirPath
			? `${targetDirPath}/${node.name}`
			: node.name;
		if (newPath === node.path) return;
		const res = await fetch(withWs("/api/wiki/move"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: node.path, to: newPath }),
		});
		if (res.ok) {
			const sourceParent = node.path.includes("/")
				? node.path.split("/").slice(0, -1).join("/")
				: "";
			await fileTree.reloadDir(sourceParent);
			if (targetDirPath !== sourceParent)
				await fileTree.reloadDir(targetDirPath);
			if (doc.openFile?.path === node.path)
				doc.openViewer({
					path: newPath,
					name: node.name,
					type: node.type,
					modifiedAt: node.modifiedAt,
				} as TreeNodeAlias);
		}
	}

	const treeHandlersRef = useRef<TreeCtx | null>(null);
	treeHandlersRef.current = {
		toggleFolder: (n) => void fileTree.toggleFolder(n),
		openViewer: (n) => void doc.openViewer(n),
		copyPath: (p) => doc.copyPath(p),
		copyWikiLink: (n) => doc.copyWikiLink(n),
		copyUrl: (p) => doc.copyUrl(p),
		copyRawContent: (p) => void doc.copyRawContent(p),
		copyFormattedContent: (p, n) => void doc.copyFormattedContent(p, n),
		handleDownload,
		triggerUpload: (d) => upload.triggerUpload(d),
		handleCreateFile,
		handleCreateFolder,
		handleDragStart,
		handleDragOver,
		handleDropOnFolder: (e, p) => void handleDropOnFolder(e, p),
		handleGitPull: (p, d) => void fileTree.handleGitPull(p, d),
		handleCheckout: (p, b, d) => void fileTree.handleCheckout(p, b, d),
		loadBranches: (p) => void fileTree.loadBranches(p),
		prefetch: (n) => void fileTree.prefetch(n),
		toggleFavorite: (node, wsId) =>
			useFavoriteStore
				.getState()
				.toggle(
					{ path: node.path, name: node.name, type: node.type },
					wsId,
				),
		setDragOverPath,
		setSidebarCollapsed,
		setBranchDropdownNode: (p) => fileTree.setBranchDropdownNode(p),
		setBranchDropdownPos: (p) => fileTree.setBranchDropdownPos(p),
		setNewFileParent: (p) =>
			setCreateEntry((prev) => ({
				...prev,
				file: { ...prev.file, parent: p, error: null },
			})),
		setNewFileName: (s) =>
			setCreateEntry((prev) => ({
				...prev,
				file: { ...prev.file, name: s },
			})),
		setFileCreateError: (s) =>
			setCreateEntry((prev) => ({
				...prev,
				file: { ...prev.file, error: s },
			})),
		setNewFolderParent: (p) =>
			setCreateEntry((prev) => ({
				...prev,
				folder: { ...prev.folder, parent: p, error: null },
			})),
		setNewFolderName: (s) =>
			setCreateEntry((prev) => ({
				...prev,
				folder: { ...prev.folder, name: s },
			})),
		setFolderError: (s) =>
			setCreateEntry((prev) => ({
				...prev,
				folder: { ...prev.folder, error: s },
			})),
		setDeletingPath: (p) => setDeleting((prev) => ({ ...prev, path: p })),
		setDeletingIsDir: (b) => setDeleting((prev) => ({ ...prev, isDir: b })),
	} as TreeCtx;
	const treeCtx = useMemo<TreeCtx>(() => ({
		toggleFolder: (n) => treeHandlersRef.current!.toggleFolder(n),
		openViewer: (n) => treeHandlersRef.current!.openViewer(n),
		copyPath: (p) => treeHandlersRef.current!.copyPath(p),
		copyWikiLink: (n) => treeHandlersRef.current!.copyWikiLink(n),
		copyUrl: (p) => treeHandlersRef.current!.copyUrl(p),
		copyRawContent: (p) => treeHandlersRef.current!.copyRawContent(p),
		copyFormattedContent: (p, n) =>
			treeHandlersRef.current!.copyFormattedContent(p, n),
		handleDownload: (n) => treeHandlersRef.current!.handleDownload(n),
		triggerUpload: (d) => treeHandlersRef.current!.triggerUpload(d),
		handleCreateFile: () => treeHandlersRef.current!.handleCreateFile(),
		handleCreateFolder: () => treeHandlersRef.current!.handleCreateFolder(),
		handleDragStart: (e, n) => treeHandlersRef.current!.handleDragStart(e, n),
		handleDragOver: (e, p, t) =>
			treeHandlersRef.current!.handleDragOver(e, p, t),
		handleDropOnFolder: (e, p) =>
			treeHandlersRef.current!.handleDropOnFolder(e, p),
		handleGitPull: (p, d) => treeHandlersRef.current!.handleGitPull(p, d),
		handleCheckout: (p, b, d) =>
			treeHandlersRef.current!.handleCheckout(p, b, d),
		loadBranches: (p) => treeHandlersRef.current!.loadBranches(p),
		prefetch: (n) => treeHandlersRef.current!.prefetch(n),
		toggleFavorite: (n, w) => treeHandlersRef.current!.toggleFavorite(n, w),
		setDragOverPath: (p) => treeHandlersRef.current!.setDragOverPath(p),
		setSidebarCollapsed: (b) =>
			treeHandlersRef.current!.setSidebarCollapsed(b),
		setBranchDropdownNode: (p) =>
			treeHandlersRef.current!.setBranchDropdownNode(p),
		setBranchDropdownPos: (p) =>
			treeHandlersRef.current!.setBranchDropdownPos(p),
		setNewFileParent: (p) => treeHandlersRef.current!.setNewFileParent(p),
		setNewFileName: (s) => treeHandlersRef.current!.setNewFileName(s),
		setFileCreateError: (s) =>
			treeHandlersRef.current!.setFileCreateError(s),
		setNewFolderParent: (p) =>
			treeHandlersRef.current!.setNewFolderParent(p),
		setNewFolderName: (s) => treeHandlersRef.current!.setNewFolderName(s),
		setFolderError: (s) => treeHandlersRef.current!.setFolderError(s),
		setDeletingPath: (p) => treeHandlersRef.current!.setDeletingPath(p),
		setDeletingIsDir: (b) => treeHandlersRef.current!.setDeletingIsDir(b),
	}), []);

	return (
		<>
			<SearchCommandDialog
				onOpenFile={doc.openFromSearch}
				recents={recents}
				onToggleSidebar={() =>
					setSidebarCollapsed((v) => {
						const next = !v;
						if (isMobile && next === false)
							useAIPanelStore.getState().close();
						return next;
					})
				}
				onNewFile={() =>
					setCreateEntry((prev) => ({
						...prev,
						file: { ...prev.file, parent: "" },
					}))
				}
				onCopyPath={() => {
					if (doc.openFile) doc.copyPath(doc.openFile.path);
				}}
			/>
			<Sidebar
				workspace={workspace}
				doc={doc}
				fileTree={fileTree}
				upload={upload}
				isMobile={isMobile}
				hideChrome={hideChrome}
				sidebarCollapsed={sidebarCollapsed}
				setSidebarCollapsed={setSidebarCollapsed}
				sidebarResizing={sidebarResizing}
				setSidebarResizing={setSidebarResizing}
				sidebarWidth={sidebarWidth}
				setSidebarWidth={setSidebarWidth}
				collapsed={collapsed}
				setCollapsed={setCollapsed}
				createEntry={createEntry}
				setCreateEntry={setCreateEntry}
				handleCreateFile={handleCreateFile}
				handleCreateFolder={handleCreateFolder}
				dragOverPath={dragOverPath}
				setDragOverPath={setDragOverPath}
				handleDragOver={handleDragOver}
				handleDropOnFolder={handleDropOnFolder}
				sidebarScrollRef={sidebarScrollRef}
				treeCtx={treeCtx}
				favorites={favorites}
				recents={recents}
				activePaths={activePaths}
				setDialogs={setDialogs}
				handleRefreshWorkspace={workspace.handleRefreshWorkspace}
			/>
		</>
	);
}
