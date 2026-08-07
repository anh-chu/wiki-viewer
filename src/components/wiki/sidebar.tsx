"use client";

import type { Dispatch, DragEvent, RefObject, SetStateAction } from "react";
import {
	AlertCircle,
	Bot,
	Check,
	ChevronDown,
	ChevronRight,
	DownloadCloud,
	Eye,
	EyeOff,
	FilePlus,
	FileText,
	Folder,
	FolderPlus,
	History,
	Loader2,
	Moon,
	MoreHorizontal,
	PanelLeftClose,
	Star,
	Plus,
	RefreshCw,
	Settings,
	Sun,
	Type,
	Upload,
	X,
} from "lucide-react";

import { SidebarSearchBox } from "@/components/search/sidebar-search-box";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	FileContextMenuItems,
	FileTree,
	FileTypeIcon,
	type TreeCtx,
} from "@/components/wiki/file-tree";
import { WorkspaceMenu } from "@/components/wiki/workspace-menu";
import type { FileTreeApi } from "@/hooks/use-file-tree";
import { useOpenFile } from "@/hooks/use-open-file";
import { useUpload } from "@/hooks/use-upload";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { apiUrl } from "@/lib/url-prefix";
import { cn } from "@/lib/utils";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useHumanizeStore } from "@/stores/humanize-store";
import { useFavoriteStore } from "@/stores/favorite-store";
import { useShowHiddenStore } from "@/stores/show-hidden-store";
import {
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "@/stores/sidebar-width-store";
import { useTheme } from "next-themes";

import type { FavoriteEntry } from "@/stores/favorite-store";
import type { RecentEntry } from "@/stores/recent-store";
import type { FileTreeNode } from "@/types/wiki";

type TreeNodeAlias = FileTreeNode;

function nameFromPath(p: string) {
	return p.split("/").pop() ?? p;
}

export interface SidebarProps {
	workspace: ReturnType<typeof useWorkspaces>;
	doc: ReturnType<typeof useOpenFile>;
	fileTree: FileTreeApi;
	upload: ReturnType<typeof useUpload>;
	isMobile: boolean;
	hideChrome: boolean;
	sidebarCollapsed: boolean;
	setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
	sidebarResizing: boolean;
	setSidebarResizing: Dispatch<SetStateAction<boolean>>;
	sidebarWidth: number;
	setSidebarWidth: (width: number) => void;
	collapsed: { favorites: boolean; recent: boolean };
	setCollapsed: Dispatch<SetStateAction<{ favorites: boolean; recent: boolean }>>;
	createEntry: {
		file: { parent: string | null; name: string; error: string | null };
		folder: { parent: string | null; name: string; error: string | null };
	};
	setCreateEntry: Dispatch<
		SetStateAction<{
			file: { parent: string | null; name: string; error: string | null };
			folder: { parent: string | null; name: string; error: string | null };
		}>
	>;
	handleCreateFile: () => void;
	handleCreateFolder: () => void;
	dragOverPath: string | null;
	setDragOverPath: Dispatch<SetStateAction<string | null>>;
	handleDragOver: (
		e: DragEvent,
		targetPath: string,
		targetType: "dir" | "root",
	) => void;
	handleDropOnFolder: (e: DragEvent, targetDirPath: string) => void;
	sidebarScrollRef: RefObject<HTMLDivElement | null>;
	treeCtx: TreeCtx;
	favorites: FavoriteEntry[];
	recents: RecentEntry[];
	activePaths: Set<string>;
	setDialogs: Dispatch<
		SetStateAction<{ settingsOpen: boolean; shareDialogOpen: boolean }>
	>;
	handleRefreshWorkspace: (id: string) => void;
}

export function Sidebar({
	workspace,
	doc,
	fileTree,
	upload,
	isMobile,
	hideChrome,
	sidebarCollapsed,
	setSidebarCollapsed,
	sidebarResizing,
	setSidebarResizing,
	sidebarWidth,
	setSidebarWidth,
	collapsed,
	setCollapsed,
	createEntry,
	setCreateEntry,
	handleCreateFile,
	handleCreateFolder,
	dragOverPath,
	setDragOverPath,
	handleDragOver,
	handleDropOnFolder,
	sidebarScrollRef,
	treeCtx,
	favorites,
	recents,
	activePaths,
	setDialogs,
	handleRefreshWorkspace,
}: SidebarProps) {
	const { resolvedTheme, setTheme } = useTheme();
	const humanize = useHumanizeStore((s) => s.humanize);
	const showHidden = useShowHiddenStore((s) => s.showHidden);

	return (
					<>
						{/* Tree sidebar */}
					{!hideChrome && !sidebarCollapsed && isMobile && (
						<div
							className="fixed inset-0 z-40 bg-overlay backdrop-blur-[1px] md:hidden"
							onClick={() => setSidebarCollapsed(true)}
							aria-hidden
						/>
					)}
					{!hideChrome && !sidebarCollapsed && (
						<Card
							style={isMobile ? undefined : { width: sidebarWidth }}
							className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[20rem] md:relative md:z-auto md:w-auto md:max-w-none flex flex-col shrink-0 overflow-hidden rounded-none border-r border-l-0 border-t-0 border-b-0"
						>
							{/* Row 1: brand + collapse */}
							<div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted shrink-0">
								<div
									className="flex min-w-0 items-center gap-1.5"
									title={`Wiki Viewer v${process.env.NEXT_PUBLIC_APP_VERSION}`}
								>
									<img
										src={apiUrl("/logo.svg")}
										alt="Wiki Viewer"
										className="h-5 w-5 shrink-0"
									/>
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
											disabled={upload.uploading}
										>
											{upload.uploading ? (
												<Loader2 className="h-3.5 w-3.5 animate-spin" />
											) : (
												<Plus className="h-3.5 w-3.5" />
											)}
											New
											<ChevronDown className="h-3 w-3 opacity-60" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="start"
										className="w-44"
									>
										<DropdownMenuItem
											onClick={() =>
												setCreateEntry((prev) => ({
													...prev,
													file: {
														...prev.file,
														parent: "",
														name: "",
														error: null,
													},
												}))
											}
										>
											<FilePlus className="mr-2 h-3.5 w-3.5" />
											New file
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												setCreateEntry((prev) => ({
													...prev,
													folder: {
														...prev.folder,
														parent: "",
														name: "",
														error: null,
													},
												}))
											}
										>
											<FolderPlus className="mr-2 h-3.5 w-3.5" />
											New folder
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => upload.triggerUpload("")}
											disabled={upload.uploading}
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
										onClick={() => void fileTree.refreshTree()}
										disabled={fileTree.refreshingTree}
									>
										{fileTree.refreshingTree ? (
											<Loader2 className="h-3.5 w-3.5 animate-spin" />
										) : (
											<RefreshCw className="h-3.5 w-3.5" />
										)}
									</Button>
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
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												size="sm"
												variant="ghost"
												className="h-7 w-7 p-0"
												title="More actions"
											>
												<MoreHorizontal className="h-3.5 w-3.5" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="end"
											className="w-48"
										>
											{workspace.isWsAdmin &&
												workspace.workspaces.find(
													(w) =>
														w.id ===
														workspace.activeWorkspaceId,
												)?.git && (
													<DropdownMenuItem
														onClick={() => {
															if (
																workspace.activeWorkspaceId
															)
																void handleRefreshWorkspace(
																	workspace.activeWorkspaceId,
																);
														}}
														disabled={
															workspace.refreshingWsId ===
															workspace.activeWorkspaceId
														}
													>
														{workspace.refreshingWsId ===
														workspace.activeWorkspaceId ? (
															<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
														) : (
															<DownloadCloud className="mr-2 h-3.5 w-3.5" />
														)}
														Pull latest
													</DropdownMenuItem>
												)}
											<DropdownMenuItem
												onClick={() =>
													useShowHiddenStore.getState().toggle()
												}
											>
												{showHidden ? (
													<EyeOff className="mr-2 h-3.5 w-3.5" />
												) : (
													<Eye className="mr-2 h-3.5 w-3.5" />
												)}
												{showHidden
													? "Hide hidden files"
													: "Show hidden files"}
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() =>
													useHumanizeStore.getState().toggle()
												}
											>
												<Type className="mr-2 h-3.5 w-3.5" />
												{humanize
													? "Raw file names"
													: "Humanize names"}
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={() =>
													setTheme(
														resolvedTheme === "dark"
															? "light"
															: "dark",
													)
												}
											>
												{resolvedTheme === "dark" ? (
													<Sun className="mr-2 h-3.5 w-3.5" />
												) : (
													<Moon className="mr-2 h-3.5 w-3.5" />
												)}
												{resolvedTheme === "dark"
													? "Light mode"
													: "Dark mode"}
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={() =>
													setDialogs((d) => ({
														...d,
														settingsOpen: true,
													}))
												}
											>
												<Settings className="mr-2 h-3.5 w-3.5" />
												Settings
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</div>

							{upload.uploadError && (
								<div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-destructive bg-destructive/10 shrink-0">
									<AlertCircle className="h-3.5 w-3.5 shrink-0" />
									{upload.uploadError}
								</div>
							)}

							{createEntry.folder.parent === "" && (
								<div className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0">
									<Folder className="h-4 w-4 shrink-0 text-warning" />
									<input
										className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
										placeholder="Folder name"
										value={createEntry.folder.name}
										onChange={(e) =>
											setCreateEntry((prev) => ({
												...prev,
												folder: {
													...prev.folder,
													name: e.target.value,
												},
											}))
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleCreateFolder();
											if (e.key === "Escape") {
												setCreateEntry((prev) => ({
													...prev,
													folder: {
														...prev.folder,
														parent: null,
														name: "",
													},
												}));
											}
										}}
									/>
									{createEntry.folder.error && (
										<span className="text-xs text-destructive">
											{createEntry.folder.error}
										</span>
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
										onClick={() =>
											setCreateEntry((prev) => ({
												...prev,
												folder: {
													...prev.folder,
													parent: null,
													name: "",
												},
											}))
										}
									>
										<X className="h-3 w-3" />
									</Button>
								</div>
							)}

							{createEntry.file.parent === "" && (
								<div className="flex items-center gap-1.5 px-2 py-1 border-b shrink-0">
									<FileText className="h-4 w-4 shrink-0 text-accent" />
									<input
										autoFocus
										className="flex-1 bg-transparent text-sm outline-none border-b border-border min-w-0"
										placeholder="filename (default .md)"
										value={createEntry.file.name}
										onChange={(e) =>
											setCreateEntry((prev) => ({
												...prev,
												file: {
													...prev.file,
													name: e.target.value,
												},
											}))
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") handleCreateFile();
											if (e.key === "Escape") {
												setCreateEntry((prev) => ({
													...prev,
													file: {
														...prev.file,
														parent: null,
														name: "",
													},
												}));
											}
										}}
									/>
									{createEntry.file.error && (
										<span className="text-xs text-destructive">
											{createEntry.file.error}
										</span>
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
										onClick={() =>
											setCreateEntry((prev) => ({
												...prev,
												file: {
													...prev.file,
													parent: null,
													name: "",
												},
											}))
										}
									>
										<X className="h-3 w-3" />
									</Button>
								</div>
							)}

							<div className="border-b">
								<SidebarSearchBox onOpenFile={doc.openFromSearch} />
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
									if (
										!e.currentTarget.contains(
											e.relatedTarget as Node,
										)
									)
										setDragOverPath(null);
								}}
								onDrop={(e) => handleDropOnFolder(e, "")}
							>
								{/* Pinned section */}
								{favorites.length > 0 && (
									<div className="border-b mb-1">
										<button
											type="button"
											className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
											onClick={() =>
												setCollapsed((c) => ({
													...c,
													favorites: !c.favorites,
												}))
											}
										>
											{collapsed.favorites ? (
												<ChevronRight className="h-3 w-3" />
											) : (
												<ChevronDown className="h-3 w-3" />
											)}
											<Star className="h-3 w-3" />
											Favorites
											<span className="ml-auto text-[9px] tabular-nums opacity-60">
												{favorites.length}
											</span>
										</button>
										{!collapsed.favorites &&
											favorites.map((p) => (
												<ContextMenu key={p.path}>
													<ContextMenuTrigger asChild>
														<div
															role="button"
															tabIndex={0}
															className={cn(
																"group flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors select-none",
																doc.openFile?.path === p.path
																	? "bg-accent-soft text-foreground font-medium"
																	: "hover:bg-muted",
															)}
															onClick={() => {
																void doc.openFavoriteEntry(p);
															}}
															onKeyDown={(e) => {
																if (
																	e.key === "Enter" ||
																	e.key === " "
																) {
																	e.preventDefault();
																	void doc.openFavoriteEntry(p);
																}
															}}
														>
															<FileTypeIcon
																name={p.name}
																type={
																	(p.type ??
																		"file") as TreeNodeAlias["type"]
																}
															/>
															<span
																className="min-w-0 flex-1 truncate text-xs"
																title={
																	humanize ? p.name : undefined
																}
															>
																{humanize
																	? nameFromPath(p.name)
																	: p.name}
															</span>
															<span className="max-w-[80px] truncate text-[10px] text-muted-foreground/60">
																{p.path
																	.split("/")
																	.slice(0, -1)
																	.join("/")}
															</span>
															<button
																type="button"
																className="hover-reveal shrink-0 rounded p-0.5 text-muted-foreground/50 opacity-0 transition-colors hover:bg-muted hover:text-amber-400 group-hover:opacity-100 focus:opacity-100"
																title="Remove from favorites"
																onClick={(e) => {
																	e.stopPropagation();
																	useFavoriteStore
																		.getState()
																		.toggle(
																				{
																					path: p.path,
																					name: p.name,
																				},
																				workspace.activeWorkspaceId,
																			);
																}}
															>
																<X className="h-3 w-3" />
															</button>
														</div>
													</ContextMenuTrigger>
													<FileContextMenuItems
														node={{
															path: p.path,
															name: p.name,
															type: (p.type ??
																"file") as TreeNodeAlias["type"],
														} as TreeNodeAlias}
														ctx={treeCtx}
														isFavorited={true}
														activeWorkspaceId={
															workspace.activeWorkspaceId
														}
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
											onClick={() =>
												setCollapsed((c) => ({
													...c,
													recent: !c.recent,
												}))
											}
										>
											{collapsed.recent ? (
												<ChevronRight className="h-3 w-3" />
											) : (
												<ChevronDown className="h-3 w-3" />
											)}
											<History className="h-3 w-3" />
											Recent
											<span className="ml-auto text-[9px] tabular-nums opacity-60">
												{recents.length}
											</span>
										</button>
										{!collapsed.recent &&
											recents.slice(0, 8).map((r) => (
												<ContextMenu key={r.path}>
													<ContextMenuTrigger asChild>
														<div
															role="button"
															tabIndex={0}
															className={cn(
																"flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm cursor-pointer transition-colors select-none",
																doc.openFile?.path === r.path
																	? "bg-accent-soft text-foreground font-medium"
																	: "hover:bg-muted",
															)}
															onClick={() => {
																void doc.openViewer({
																	path: r.path,
																	name: r.name,
																	type: (r.type ??
																		"file") as TreeNodeAlias["type"],
																	modifiedAt: "",
																} as TreeNodeAlias);
																if (isMobile)
																	setSidebarCollapsed(true);
															}}
															onKeyDown={(e) => {
																if (
																	e.key === "Enter" ||
																	e.key === " "
																) {
																	e.preventDefault();
																	void doc.openViewer({
																		path: r.path,
																		name: r.name,
																		type: (r.type ??
																			"file") as TreeNodeAlias["type"],
																		modifiedAt: "",
																	} as TreeNodeAlias);
																}
															}}
														>
															<FileTypeIcon
																name={r.name}
																type={
																	(r.type ??
																		"file") as TreeNodeAlias["type"]
																}
															/>
															<span
																className="flex-1 truncate text-xs"
																title={
																	humanize ? r.name : undefined
																}
															>
																{humanize
																	? nameFromPath(r.name)
																	: r.name}
															</span>
															<span className="text-[10px] text-muted-foreground/60 truncate max-w-[80px]">
																{r.path
																	.split("/")
																	.slice(0, -1)
																	.join("/")}
															</span>
														</div>
													</ContextMenuTrigger>
													<FileContextMenuItems
														node={{
															path: r.path,
															name: r.name,
															type: (r.type ??
																"file") as TreeNodeAlias["type"],
														} as TreeNodeAlias}
														ctx={treeCtx}
														isFavorited={favorites.some(
															(fav) => fav.path === r.path,
														)}
														activeWorkspaceId={
															workspace.activeWorkspaceId
														}
													/>
												</ContextMenu>
											))}
									</div>
								)}
								{fileTree.rootLoading ? (
									<div className="flex justify-center py-6">
										<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
									</div>
								) : fileTree.roots.length === 0 ? (
									<div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
										<div className="rounded-full bg-muted p-3">
											<FileText className="h-6 w-6 text-muted-foreground" />
										</div>
										<div className="space-y-1">
											<p className="text-sm font-medium">
												No files yet
											</p>
											<p className="text-xs text-muted-foreground">
												Upload files or add them to the
												configured directory
											</p>
										</div>
										<Button
											size="sm"
											variant="outline"
											className="w-full gap-1.5 max-w-[180px]"
											onClick={() => upload.triggerUpload("")}
											disabled={upload.uploading}
										>
											{upload.uploading ? (
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
										nodes={fileTree.roots}
										openPath={doc.openFile?.path ?? null}
										dragOverPath={dragOverPath}
										branchDropdownNode={fileTree.branchDropdownNode}
										branchDropdownPos={fileTree.branchDropdownPos}
										nodeBranches={fileTree.nodeBranches}
										branchesLoading={fileTree.branchesLoading}
										checkingOutBranch={fileTree.checkingOutBranch}
										pullingRepo={fileTree.pullingRepo}
										activePaths={activePaths}
										favorites={favorites}
										isMobile={isMobile}
										activeWorkspaceId={workspace.activeWorkspaceId}
										newFileParent={createEntry.file.parent}
										newFileName={createEntry.file.name}
										fileCreateError={createEntry.file.error}
										newFolderParent={createEntry.folder.parent}
										newFolderName={createEntry.folder.name}
										folderError={createEntry.folder.error}
										sidebarScrollRef={sidebarScrollRef}
									/>
								)}
							</div>

							<WorkspaceMenu
								workspaces={workspace.workspaces}
								activeWorkspaceId={workspace.activeWorkspaceId}
								rootPath={workspace.rootPath}
								isWsAdmin={workspace.isWsAdmin}
								refreshingWsId={workspace.refreshingWsId}
								switchingBranch={workspace.switchingBranch}
								switchingBranchName={workspace.switchingBranchName}
								wsBranches={workspace.wsBranches}
								branchPickerWsId={workspace.branchPickerWsId}
								wsBranchPos={workspace.wsBranchPos}
								onSwitchWorkspace={(id) =>
									void workspace.switchWorkspace(id)
								}
								onRefreshWorkspace={workspace.handleRefreshWorkspace}
								onPromptDeleteWorkspace={(id) =>
									workspace.setDeletingWorkspaceId(id)
								}
								onAddWorkspace={() => workspace.setAddingWorkspace(true)}
								setBranchPickerWsId={workspace.setBranchPickerWsId}
								setWsBranchPos={workspace.setWsBranchPos}
								loadWsBranches={workspace.loadWsBranches}
								handleSwitchBranch={workspace.handleSwitchBranch}
							/>

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
									const prevSelect =
										document.body.style.userSelect;
									document.body.style.cursor = "col-resize";
									document.body.style.userSelect = "none";
									const onMove = (ev: MouseEvent) => {
										setSidebarWidth(startW + (ev.clientX - startX));
									};
									const onUp = () => {
										setSidebarResizing(false);
										document.body.style.cursor = prevCursor;
										document.body.style.userSelect = prevSelect;
										window.removeEventListener(
											"mousemove",
											onMove,
										);
										window.removeEventListener(
											"mouseup",
											onUp,
										);
									};
									window.addEventListener(
										"mousemove",
										onMove,
									);
									window.addEventListener(
										"mouseup",
										onUp,
									);
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
					</>
	);
}
