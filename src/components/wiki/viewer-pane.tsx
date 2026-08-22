"use client";

import {
	Check,
	Code2,
	Eye,
	File,
	FilePlus2,
	FileText,
	Globe,
	History,
	Image as ImageIcon,
	Loader2,
	Maximize2,
	PencilRuler,
	Pencil,
	RefreshCw,
	Share,
	User,
	X,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { withWs } from "@/lib/workspace-client";
import type { OpenFile } from "@/types/wiki";
import {
	VIEW_ALIGN_CLASS,
	VIEW_ALIGN_LABEL,
	VIEW_ALIGN_ORDER,
	VIEW_WIDTH_CLASS,
	VIEW_WIDTH_LABEL,
	VIEW_WIDTH_ORDER,
} from "@/stores/view-width-store";

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
import { SourceViewer } from "@/components/editor/source-viewer";
import { WebsiteViewer } from "@/components/editor/website-viewer";
import { NodeAppViewer } from "@/components/editor/node-app-viewer";
import {
	ViewerToolbarBadgeSlotContext,
	ViewerToolbarSlotContext,
} from "@/components/layout/viewer-toolbar";

const PdfViewer = dynamic(
	() => import("@/components/editor/pdf-viewer").then((m) => m.PdfViewer),
	{ ssr: false },
);
const CanvasViewer = dynamic(
	() => import("@/components/editor/canvas-viewer").then((m) => m.CanvasViewer),
	{ ssr: false },
);

import {
	ext,
	isHtmlFile,
	isImage,
	isMarkdown,
	isText,
	viewerKindFor,
} from "./file-tree";

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

// Viewer kinds safe to open at any size: they stream, paginate, or proxy and
// never load the whole file into JS. Everything else goes behind LargeFileGate,
// so a new viewer is fail-safe by default until proven safe here.
const SAFE_VIEWER_KINDS = new Set([
	"image",
	"media",
	"pdf",
	"fallback",
	"app",
	"node-app",
	"html",
]);

const LARGE_FILE_GATE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface HistoryCommit {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string;
}

export interface GitFileInfo {
	sha: string;
	author: string;
	date: string;
}

export interface ViewerPaneProps {
	openFile: OpenFile;
	fileContent: string | null;
	fileRevision: number;
	fileLoading: boolean;
	editing: boolean;
	setEditing: (editing: boolean) => void;
	editContent: string;
	setEditContent: (content: string) => void;
	saving: boolean;
	saveError: string | null;
	onSave: () => void;
	gitFileInfo: GitFileInfo | null;
	showHistory: boolean;
	historyLoading: boolean;
	historyCommits: HistoryCommit[];
	selectedDiffSha: string | null;
	diffContent: string | null;
	diffLoading: boolean;
	onToggleHistory: () => void;
	onSelectDiff: (sha: string) => void;
	gateBypassPath: string | null;
	onBypassGate: () => void;
	onRefresh: () => void;
	onShare: () => void;
	onClose: () => void;
	onPromoteScratch?: () => void;
	renderCopyMenu: (
		node: { path: string; name: string },
		extraItems?: React.ReactNode,
	) => React.ReactNode;
	appKey: number;
	setAppKey: (fn: (k: number) => number) => void;
	appFullscreen: boolean;
	setAppFullscreen: (fullscreen: boolean) => void;
	viewerKey: number;
	setViewerKey: (fn: (k: number) => number) => void;
	htmlSourceMode: boolean;
	setHtmlSourceMode: (v: boolean) => void;
	widthAwareViewer: boolean;
	viewWidth: string;
	viewAlign: string;
	setViewWidth: (w: string) => void;
	setViewAlign: (a: string) => void;
	contentWidthClass: string;
	contentAlignClass: string;
	isMobile: boolean;
	sidebarCollapsed: boolean;
}

export function ViewerPane({
	openFile,
	fileContent,
	fileLoading,
	editing,
	setEditing,
	editContent,
	setEditContent,
	saving,
	saveError,
	onSave,
	gitFileInfo,
	showHistory,
	historyLoading,
	historyCommits,
	selectedDiffSha,
	diffContent,
	diffLoading,
	onToggleHistory,
	onSelectDiff,
	gateBypassPath,
	onBypassGate,
	onRefresh,
	onShare,
	onClose,
	onPromoteScratch,
	renderCopyMenu,
	appKey,
	setAppKey,
	appFullscreen,
	setAppFullscreen,
	viewerKey,
	setViewerKey,
	htmlSourceMode,
	setHtmlSourceMode,
	widthAwareViewer,
	viewWidth,
	viewAlign,
	setViewWidth,
	setViewAlign,
	contentWidthClass,
	contentAlignClass,
	isMobile,
	sidebarCollapsed,
}: ViewerPaneProps) {
	// Portal target for merging viewer toolbar content into single header row
	const [toolbarSlotEl, setToolbarSlotEl] = useState<HTMLElement | null>(null);
	const [toolbarBadgeSlotEl, setToolbarBadgeSlotEl] = useState<HTMLElement | null>(null);

	// Lifted so it survives the header's Refresh action (which remounts
	// WebsiteViewer via a changing key), but resets on a genuinely different file.
	const [scriptsEnabled, setScriptsEnabled] = useState(false);
	useEffect(() => {
		setScriptsEnabled(false);
	}, [openFile.path, openFile.externalUrl]);

	const viewerKind = viewerKindFor(openFile.name, openFile.nodeType);
	const showLargeFileGate =
		!SAFE_VIEWER_KINDS.has(viewerKind) &&
		(openFile.size ?? 0) > LARGE_FILE_GATE_BYTES &&
		gateBypassPath !== openFile.path;

	if (viewerKind === "node-app") {
		return <NodeAppViewer path={openFile.path} title={openFile.name} />;
	}

	const isScratch = openFile.path.startsWith(".scratch/");

	const websiteSrc = openFile.externalUrl
		? openFile.externalUrl
		: viewerKind === "html"
			? withWs(`/api/assets/${openFile.path}`)
			: undefined;

	if (viewerKind === "app" || viewerKind === "html") {
		if (appFullscreen) {
			return (
				<WebsiteViewer
					scriptsEnabled={scriptsEnabled}
					onToggleScripts={() => setScriptsEnabled((s) => !s)}
					path={openFile.path}
					title={openFile.name}
					src={websiteSrc}
					fullscreen
					onExit={() => setAppFullscreen(false)}
				/>
			);
		}
		return (
			<div className="flex-1 flex flex-col overflow-hidden min-w-0">
				<div
					className={cn(
						"flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0 ",
						!isMobile && sidebarCollapsed && "pl-11",
					)}
				>
					<div className="flex items-center gap-2 min-w-0">
						<span className="hidden md:inline-flex">
							<span className="">
								<Globe className="h-4 w-4 shrink-0 text-foreground/70" />
							</span>
						</span>
						<span
							className="hidden md:inline text-sm font-normal truncate"
							title={openFile.path}
						>
							{openFile.path}
						</span>
						<div
							ref={(el) => {
								if (el) setToolbarBadgeSlotEl(el);
							}}
							className="flex items-center gap-1 shrink-0"
						/>
					</div>
					<div className="flex items-center gap-1 shrink-0">
					<div
						ref={(el) => {
							if (el) setToolbarSlotEl(el);
						}}
						className="flex items-center gap-1 shrink-0"
					/>
						{renderCopyMenu(
							openFile,
							<>
								{viewerKind === "html" && !editing && (
									<DropdownMenuItem
										onClick={() => setHtmlSourceMode(!htmlSourceMode)}
									>
										{htmlSourceMode ? (
											<Globe className="mr-2 h-3.5 w-3.5" />
										) : (
											<Code2 className="mr-2 h-3.5 w-3.5" />
										)}
										{htmlSourceMode ? "Show preview" : "Show source"}
									</DropdownMenuItem>
								)}
								<DropdownMenuItem onClick={() => setAppKey((k) => k + 1)}>
									<RefreshCw className="mr-2 h-3.5 w-3.5" />
									Refresh
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => setAppFullscreen(true)}>
									<Maximize2 className="mr-2 h-3.5 w-3.5" />
									Open fullscreen
								</DropdownMenuItem>
								<DropdownMenuItem onClick={onShare}>
									<Share className="mr-2 h-3.5 w-3.5" />
									Share
								</DropdownMenuItem>
								{isScratch && onPromoteScratch && (
									<DropdownMenuItem onClick={onPromoteScratch}>
										<FilePlus2 className="mr-2 h-3.5 w-3.5" />
										Save to file…
									</DropdownMenuItem>
								)}
							</>,
						)}
						{viewerKind === "html" && !editing && fileContent !== null && (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								title="Edit source"
								onClick={() => {
									setEditing(true);
									setEditContent(fileContent);
								}}
							>
								<Pencil className="h-3.5 w-3.5" />
							</Button>
						)}
						<Button
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0"
							onClick={onClose}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
				</div>
				{editing && viewerKind === "html" ? (
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
								onClick={() => setEditing(false)}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								className="gap-1"
								onClick={onSave}
								disabled={saving}
							>
								{saving && <Loader2 className="h-3 w-3 animate-spin" />}
								Save
							</Button>
						</div>
					</div>
				) : htmlSourceMode && viewerKind === "html" ? (
					<ViewerToolbarBadgeSlotContext.Provider value={toolbarBadgeSlotEl}>
						<ViewerToolbarSlotContext.Provider value={toolbarSlotEl}>
							<SourceViewer path={openFile.path} title={openFile.name} />
						</ViewerToolbarSlotContext.Provider>
					</ViewerToolbarBadgeSlotContext.Provider>
				) : (
					<ViewerToolbarBadgeSlotContext.Provider value={toolbarBadgeSlotEl}>
						<ViewerToolbarSlotContext.Provider value={toolbarSlotEl}>
							<WebsiteViewer
								key={appKey}
								scriptsEnabled={scriptsEnabled}
								onToggleScripts={() => setScriptsEnabled((s) => !s)}
								path={openFile.path}
								title={openFile.name}
								src={websiteSrc}
							/>
						</ViewerToolbarSlotContext.Provider>
					</ViewerToolbarBadgeSlotContext.Provider>
				)}
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden min-w-0">
			<div
				className={cn(
					"flex items-center justify-between px-4 py-2 border-b bg-muted shrink-0 ",
					!isMobile && sidebarCollapsed && "pl-11",
				)}
			>
				<div className="flex items-center gap-2 min-w-0">
					<span className="hidden md:inline-flex">
						<span className="">
							{viewerKind === "canvas" ? (
								<PencilRuler className="h-4 w-4 shrink-0 text-violet-500" />
							) : isImage(openFile.name) ? (
								<ImageIcon className="h-4 w-4 shrink-0 text-sunshine-700" />
							) : isText(openFile.name) ? (
								<FileText className="h-4 w-4 shrink-0 text-foreground/70" />
							) : (
								<File className="h-4 w-4 shrink-0 text-foreground/60" />
							)}
						</span>
					</span>
					<span
						className="hidden md:inline text-sm font-normal truncate"
						title={openFile.path}
					>
						{openFile.path}
					</span>
					<div
						ref={(el) => {
							if (el) setToolbarBadgeSlotEl(el);
						}}
						className="flex items-center gap-1 shrink-0"
					/>
					{gitFileInfo && (
						<span className="hidden md:flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 ml-1">
							<User className="h-3 w-3 shrink-0" />
							<span className="truncate max-w-[100px]">
								{gitFileInfo.author}
							</span>
							<span
								title={new Date(gitFileInfo.date).toLocaleString()}
								className="shrink-0"
							>
								{timeAgo(gitFileInfo.date)}
							</span>
						</span>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<div
						ref={(el) => {
							if (el) setToolbarSlotEl(el);
						}}
						className="flex items-center gap-1 shrink-0"
					/>
					{renderCopyMenu(
						openFile,
						<>
							<DropdownMenuItem onClick={onToggleHistory}>
								<History className="mr-2 h-3.5 w-3.5" />
								{showHistory ? "Hide history" : "File history"}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={onShare}>
								<Share className="mr-2 h-3.5 w-3.5" />
								Share
							</DropdownMenuItem>
							{isScratch && onPromoteScratch && (
								<DropdownMenuItem onClick={onPromoteScratch}>
									<FilePlus2 className="mr-2 h-3.5 w-3.5" />
									Save to file…
								</DropdownMenuItem>
							)}
							{!editing && (
								<DropdownMenuItem
									onClick={onRefresh}
									disabled={fileLoading}
								>
									{fileLoading ? (
										<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
									) : (
										<RefreshCw className="mr-2 h-3.5 w-3.5" />
									)}
									Refresh
								</DropdownMenuItem>
							)}
							{widthAwareViewer && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuLabel className="text-[11px] text-muted-foreground">
										Width
									</DropdownMenuLabel>
									{VIEW_WIDTH_ORDER.map((w) => (
										<DropdownMenuItem
											key={w}
											onClick={() => setViewWidth(w)}
											className="flex items-center justify-between text-xs"
										>
											{VIEW_WIDTH_LABEL[w]}
											{w === viewWidth && (
												<Check className="h-3.5 w-3.5" />
											)}
										</DropdownMenuItem>
									))}
									<DropdownMenuSeparator />
									<DropdownMenuLabel className="text-[11px] text-muted-foreground">
										Alignment
									</DropdownMenuLabel>
									{VIEW_ALIGN_ORDER.map((a) => (
										<DropdownMenuItem
											key={a}
											onClick={() => setViewAlign(a)}
											className="flex items-center justify-between text-xs"
										>
											{VIEW_ALIGN_LABEL[a]}
											{a === viewAlign && (
												<Check className="h-3.5 w-3.5" />
											)}
										</DropdownMenuItem>
									))}
								</>
							)}
						</>,
					)}
					{isText(openFile.name) && !editing &&
						(fileContent !== null || isMarkdown(openFile.name)) && (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 p-0"
								onClick={() => {
									setEditing(true);
									setEditContent(fileContent ?? "");
								}}
							>
								<Pencil className="h-3.5 w-3.5" />
							</Button>
						)}
					{isText(openFile.name) && editing && isMarkdown(openFile.name) && (
						<Button
							size="sm"
							variant="ghost"
							className="h-7 w-7 p-0"
							title="Done editing"
							onClick={() => setEditing(false)}
						>
							<Eye className="h-3.5 w-3.5" />
						</Button>
					)}
					<Button
						size="sm"
						variant="ghost"
						className="h-7 w-7 p-0"
						onClick={onClose}
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			{showHistory && (
				<div className="border-b bg-muted/30 shrink-0 max-h-[40vh] overflow-auto">
					<div className="flex items-center justify-between px-4 py-1.5 border-b">
						<span className="text-xs font-semibold text-muted-foreground">
							History
						</span>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground"
							onClick={onToggleHistory}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
					{historyLoading ? (
						<div className="flex justify-center py-4">
							<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
						</div>
					) : historyCommits.length === 0 ? (
						<p className="px-4 py-3 text-xs text-muted-foreground">
							No history found.
						</p>
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
										onClick={() => onSelectDiff(c.sha)}
									>
										<div className="flex items-center gap-2">
											<code className="text-[11px] font-mono text-muted-foreground shrink-0">
												{c.shortSha}
											</code>
											<span className="flex-1 truncate text-xs">
												{c.message}
											</span>
											<span className="shrink-0 text-[11px] text-muted-foreground">
												{c.author}
											</span>
											<span
												className="shrink-0 text-[11px] text-muted-foreground"
												title={new Date(c.date).toLocaleString()}
											>
												{timeAgo(c.date)}
											</span>
										</div>
									</button>
									{selectedDiffSha === c.sha && (
										<div className="border-t">
											{diffLoading ? (
												<div className="flex justify-center py-3">
													<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
												</div>
											) : diffContent !== null ? (
												<pre className="overflow-auto px-4 py-2 text-[11px] font-mono leading-relaxed whitespace-pre text-foreground/80 max-h-60">
													{diffContent}
												</pre>
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
					onOpen={onBypassGate}
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
			) : viewerKind === "canvas" ||
			  viewerKind === "csv" ||
			  viewerKind === "pdf" ||
			  viewerKind === "mermaid" ||
			  viewerKind === "notebook" ||
			  viewerKind === "image" ||
			  viewerKind === "media" ||
			  viewerKind === "docx" ||
			  viewerKind === "xlsx" ||
			  viewerKind === "pptx" ||
			  viewerKind === "source" ||
			  viewerKind === "fallback" ? (
			<ViewerToolbarBadgeSlotContext.Provider value={toolbarBadgeSlotEl}>
			<ViewerToolbarSlotContext.Provider value={toolbarSlotEl}>
				<div
					key={viewerKey}
					className="flex-1 flex flex-col overflow-hidden min-h-0"
				>
					{fileLoading ? (
						<div className="flex justify-center py-8">
							<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
						</div>
					) : viewerKind === "canvas" ? (
						<CanvasViewer content={fileContent} path={openFile.path} title={openFile.name} />
					) : viewerKind === "csv" ? (
						<CsvViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "pdf" ? (
						<PdfViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "mermaid" ? (
						<MermaidViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "notebook" ? (
						<NotebookViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "image" ? (
						<ImageViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "media" ? (
						<MediaViewer
							path={openFile.path}
							title={openFile.name}
							type={
								["mp4", "webm", "mov", "m4v"].includes(ext(openFile.name))
									? "video"
									: "audio"
							}
						/>
					) : viewerKind === "docx" ? (
						<DocxViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "xlsx" ? (
						<XlsxViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "pptx" ? (
						<PptxViewer path={openFile.path} title={openFile.name} />
					) : viewerKind === "source" ? (
						<SourceViewer path={openFile.path} title={openFile.name} />
					) : (
						<FileFallbackViewer path={openFile.path} title={openFile.name} />
					)}
				</div>
			</ViewerToolbarSlotContext.Provider>
			</ViewerToolbarBadgeSlotContext.Provider>
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
						onClick={() => setEditing(false)}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						className="gap-1"
						onClick={onSave}
						disabled={saving}
					>
						{saving && <Loader2 className="h-3 w-3 animate-spin" />}
						Save
					</Button>
				</div>
			)}
		</div>
	);
}
