"use client";

import {
	Bot,
	FileText,
	Globe,
	Image as ImageIcon,
	Loader2,
	PanelLeftOpen,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { AuthSettingsSheet } from "@/components/auth-settings-sheet";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DirPicker } from "@/components/dir-picker";
import { ShareDialog } from "@/components/share-dialog";
import { AIPanel } from "@/components/ai-panel/ai-panel";
import { Button } from "@/components/ui/button";
import { FileActionsMenu } from "@/components/wiki/file-actions-menu";
import { SidebarShell } from "@/components/wiki/sidebar-shell";
import { ViewerPane } from "@/components/wiki/viewer-pane";
import { isImage, isMarkdown, isText } from "@/components/wiki/file-tree";
import { useGitHistory } from "@/hooks/use-git-history";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useOpenFile } from "@/hooks/use-open-file";
import { useUpload } from "@/hooks/use-upload";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { useFileTree } from "@/hooks/use-file-tree";
import { isLite } from "@/lib/url-prefix";
import { withWs } from "@/lib/workspace-client";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { useEditorStore, prefetchPage } from "@/stores/editor-store";
import { usePinStore } from "@/stores/pin-store";
import { useRecentStore } from "@/stores/recent-store";
import {
	useViewWidthStore,
	VIEW_WIDTH_CLASS,
	VIEW_ALIGN_CLASS,
} from "@/stores/view-width-store";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";

function nameFromPath(p: string) {
	return p.split("/").pop() ?? p;
}

export default function Page() {
	const workspace = useWorkspaces();
	const externalChangeRef = useRef<(relPath: string) => void>(() => {});
	const fileTree = useFileTree({
		activeWorkspaceId: workspace.activeWorkspaceId,
		rootConfigured: workspace.rootConfigured,
		onExternalChange: useCallback(
			(relPath: string) => externalChangeRef.current(relPath),
			[],
		),
	});
	const doc = useOpenFile({
		activeWorkspaceId: workspace.activeWorkspaceId,
		rootPath: workspace.rootPath,
		isMobile: useIsMobile(),
		setSidebarCollapsed: (v) => sidebarCollapsedSetterRef.current(v),
		treeApi: {
			revealPath: fileTree.revealPath,
			toggleFolder: fileTree.toggleFolder,
		},
	});
	useEffect(() => {
		externalChangeRef.current = doc.onExternalChange;
	}, [doc.onExternalChange]);

	const isMobile = useIsMobile();
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const sidebarCollapsedSetterRef = useRef<(v: boolean) => void>(() => {});
	sidebarCollapsedSetterRef.current = setSidebarCollapsed;
	const [dialogs, setDialogs] = useState({
		settingsOpen: false,
		shareDialogOpen: false,
	});
	const [hideChrome, setHideChrome] = useState(false);
	const [deleting, setDeleting] = useState({
		path: null as string | null,
		isDir: false,
	});

	const upload = useUpload({ reloadDir: fileTree.reloadDir });
	const gitHistory = useGitHistory(doc.openFile);

	const pins = usePinStore((s) => s.pins);
	const recents = useRecentStore((s) => s.recents);
	const activity = useAIPanelStore((s) => s.activity);
	const activePaths = useMemo(() => {
		const cutoff = new Date(Date.now() - 60 * 1000).toISOString();
		const paths = new Set<string>();
		for (const ev of activity) {
			if (ev.at >= cutoff && ev.path && ev.by?.startsWith("ai:"))
				paths.add(ev.path);
		}
		return paths;
	}, [activity]);

	// Embedding chrome visibility.
	useEffect(() => {
		const sp = new URLSearchParams(window.location.search);
		setHideChrome(
			sp.get("embed") === "1" && sp.get("chrome") !== "1",
		);
	}, []);

	// Mobile defaults sidebar closed.
	useEffect(() => {
		if (isMobile) setSidebarCollapsed(true);
	}, [isMobile]);

	// Load wiki slugs once.
	useEffect(() => {
		void useWikiSlugsStore.getState().load();
	}, []);

	// Poll agent activity for presence indicators.
	useEffect(() => {
		const load = () => {
			void useAIPanelStore.getState().loadActivity();
		};
		load();
		const id = setInterval(load, 10_000);
		return () => clearInterval(id);
	}, []);

	// Load recents and pins for the active workspace.
	useEffect(() => {
		useRecentStore.getState().loadForWorkspace(workspace.activeWorkspaceId);
		usePinStore.getState().loadForWorkspace(workspace.activeWorkspaceId);
	}, [workspace.activeWorkspaceId]);

	// Prefetch markdown pages for pins/recents at idle.
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
				? (cb) =>
						(
							window as unknown as {
								requestIdleCallback: (c: () => void) => number;
							}
						).requestIdleCallback(cb)
				: (cb) => window.setTimeout(cb, 400);
		const id = ric(() => {
			for (const p of paths) prefetchPage(p);
		});
		return () => {
			if (
				typeof window !== "undefined" &&
				"cancelIdleCallback" in window
			) {
				(
					window as unknown as {
						cancelIdleCallback: (h: number) => void;
					}
				).cancelIdleCallback(id);
			} else {
				clearTimeout(id);
			}
		};
	}, [pins, recents]);

	// Workspace switch resets the open document.
	useEffect(() => {
		doc.clearFile();
	}, [workspace.activeWorkspaceId, doc.clearFile]);

	// Signal the open-file hook once the tree is loaded so URL restore runs.
	useEffect(() => {
		if (fileTree.rootLoaded) doc.markRootLoaded();
	}, [fileTree.rootLoaded, doc.markRootLoaded]);

	async function handleDelete() {
		if (!deleting.path) return;
		await fetch(withWs("/api/wiki"), {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: deleting.path }),
		});
		if (
			doc.openFile?.path === deleting.path ||
			doc.openFile?.path.startsWith(`${deleting.path}/`)
		) {
			doc.closeFile();
		}
		const parentDir = nameFromPath(deleting.path).includes("/")
			? deleting.path.split("/").slice(0, -1).join("/")
			: "";
		await fileTree.reloadDir(parentDir);
		setDeleting({ path: null, isDir: false });
	}

	const viewWidth = useViewWidthStore((s) => s.width);
	const viewAlign = useViewWidthStore((s) => s.align);
	const setViewWidth = useViewWidthStore((s) => s.setWidth);
	const setViewAlign = useViewWidthStore((s) => s.setAlign);

	const widthAwareViewer =
		doc.openFileViewerKind === null ||
		doc.openFileViewerKind === "editor" ||
		doc.openFileViewerKind === "text" ||
		doc.openFileViewerKind === "source" ||
		doc.openFileViewerKind === "notebook" ||
		doc.openFileViewerKind === "fallback";
	const contentWidthClass = widthAwareViewer ? VIEW_WIDTH_CLASS[viewWidth] : "";
	const contentAlignClass = widthAwareViewer ? VIEW_ALIGN_CLASS[viewAlign] : "";

	const renderCopyMenu = useCallback(
		(node: { path: string; name: string }, extraItems?: ReactNode) => (
			<FileActionsMenu doc={doc} node={node} extraItems={extraItems} />
		),
		[doc],
	);

	return (
		<div
			key={workspace.activeWorkspaceId ?? "none"}
			className="flex h-screen gap-0 overflow-hidden bg-background"
		>
			{workspace.rootConfigured === null && (
				<div className="flex-1 flex items-center justify-center">
					<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			)}
			{workspace.rootConfigured === false && (
				<DirPicker
					onSelect={(workspaceId) => {
						const u = new URL(location.href);
						u.searchParams.set("ws", workspaceId);
						u.searchParams.delete("path");
						history.replaceState(null, "", u.toString());
						workspace.setRootConfigured(true);
						workspace.setActiveWorkspaceId(workspaceId);
						void workspace.loadWorkspaces();
					}}
				/>
			)}
			{workspace.rootConfigured === true && workspace.addingWorkspace && (
				<div className="flex-1 flex flex-col">
					<div className="flex items-center justify-end border-b px-3 py-2 bg-muted shrink-0">
						<Button
							size="sm"
							variant="ghost"
							className="h-7 gap-1.5 text-xs"
							onClick={() => workspace.setAddingWorkspace(false)}
						>
							<X className="h-3.5 w-3.5" /> Cancel
						</Button>
					</div>
					<DirPicker
						onSelect={(workspaceId) => {
							workspace.setAddingWorkspace(false);
							void workspace.loadWorkspaces();
							void workspace.switchWorkspace(workspaceId);
						}}
					/>
				</div>
			)}
			{workspace.rootConfigured === true && !workspace.addingWorkspace && (
				<>
					<SidebarShell
						workspace={workspace}
						doc={doc}
						fileTree={fileTree}
						upload={upload}
						isMobile={isMobile}
						hideChrome={hideChrome}
						sidebarCollapsed={sidebarCollapsed}
						setSidebarCollapsed={setSidebarCollapsed}
						pins={pins}
						recents={recents}
						activePaths={activePaths}
						setDeleting={setDeleting}
						setDialogs={setDialogs}
					/>

					{/* Right panel */}
					<div className="flex-1 flex flex-col min-w-0 relative">
						{/* Desktop: floating reopen button when sidebar is collapsed */}
						{!hideChrome && sidebarCollapsed && (
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
						{/* Mobile: dedicated top bar */}
						{!hideChrome && (
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
									title={doc.openFile?.path}
								>
									{doc.openFile && (
										<span className="editorial-tree-typeicon shrink-0">
											{doc.openFileViewerKind === "app" ||
											doc.openFileViewerKind === "html" ? (
												<Globe className="h-4 w-4 text-foreground/70" />
											) : isImage(doc.openFile.name) ? (
												<ImageIcon className="h-4 w-4 text-sunshine-700" />
											) : isText(doc.openFile.name) ? (
												<FileText className="h-4 w-4 text-foreground/70" />
											) : (
												<FileText className="h-4 w-4 text-foreground/60" />
											)}
										</span>
									)}
									<span className="truncate">
										{doc.openFile
											? doc.openFile.name
											: "Wiki Viewer"}
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
						)}

						{doc.openFile ? (
							<ViewerPane
								openFile={doc.openFile}
								fileContent={doc.fileContent}
								fileRevision={doc.fileRevision}
								fileLoading={doc.fileLoading}
								editing={doc.editing}
								setEditing={doc.setEditing}
								editContent={doc.editContent}
								setEditContent={doc.setEditContent}
								saving={doc.saving}
								saveError={doc.saveError}
								onSave={doc.handleSave}
								gitFileInfo={gitHistory.gitFileInfo}
								showHistory={gitHistory.showHistory}
								historyLoading={gitHistory.historyLoading}
								historyCommits={gitHistory.historyCommits}
								selectedDiffSha={gitHistory.selectedDiffSha}
								diffContent={gitHistory.diffContent}
								diffLoading={gitHistory.diffLoading}
								onToggleHistory={() =>
									gitHistory.setShowHistory((v) => !v)
								}
								onSelectDiff={gitHistory.selectDiff}
								gateBypassPath={doc.gateBypassPath}
								onBypassGate={doc.bypassGate}
								onRefresh={doc.handleRefresh}
								onShare={() =>
									setDialogs((d) => ({
										...d,
										shareDialogOpen: true,
									}))
								}
								onClose={() => {
									doc.closeFile();
								}}
								renderCopyMenu={renderCopyMenu}
								appKey={doc.appKey}
								setAppKey={doc.setAppKey}
								appFullscreen={doc.appFullscreen}
								setAppFullscreen={doc.setAppFullscreen}
								viewerKey={doc.viewerKey}
								setViewerKey={doc.setViewerKey}
								htmlSourceMode={doc.htmlSourceMode}
								setHtmlSourceMode={doc.setHtmlSourceMode}
								widthAwareViewer={widthAwareViewer}
								viewWidth={viewWidth}
								viewAlign={viewAlign}
								setViewWidth={setViewWidth as unknown as (w: string) => void}
								setViewAlign={setViewAlign as unknown as (a: string) => void}
								contentWidthClass={contentWidthClass}
								contentAlignClass={contentAlignClass}
								isMobile={isMobile}
								sidebarCollapsed={sidebarCollapsed}
							/>
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
						open={dialogs.shareDialogOpen}
						onOpenChange={(open) =>
							setDialogs((d) => ({ ...d, shareDialogOpen: open }))
						}
						filePath={doc.openFile?.path ?? ""}
					/>
					{!isLite() && (
						<AuthSettingsSheet
							open={dialogs.settingsOpen}
							onOpenChange={(open) =>
								setDialogs((d) => ({
									...d,
									settingsOpen: open,
								}))
							}
						/>
					)}
					<AIPanel currentPath={doc.openFile?.path} />
					<input
						ref={upload.fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files) upload.doUpload(e.target.files);
						}}
					/>

					<ConfirmDialog
						open={!!deleting.path}
						onOpenChange={(open) => {
							if (!open)
								setDeleting({ path: null, isDir: false });
						}}
						title={deleting.isDir ? "Delete folder?" : "Delete file?"}
						description={
							deleting.isDir
								? `"${nameFromPath(deleting.path ?? "")}" and all its contents will be permanently deleted.`
								: `"${nameFromPath(deleting.path ?? "")}" will be permanently removed.`
						}
						onConfirm={handleDelete}
					/>

					<ConfirmDialog
						open={!!workspace.deletingWorkspaceId}
						onOpenChange={(open) => {
							if (!open) workspace.setDeletingWorkspaceId(null);
						}}
						title="Delete workspace?"
						description={`"${workspace.workspaces.find((w) => w.id === workspace.deletingWorkspaceId)?.name ?? ""}" will be removed from the workspace list. Files on disk are NOT deleted.`}
						onConfirm={() =>
							void workspace.handleDeleteWorkspace(async (nextId) => {
								await workspace.switchWorkspace(nextId);
								doc.clearFile();
							})
						}
					/>
				</>
			)}
		</div>
	);
}
