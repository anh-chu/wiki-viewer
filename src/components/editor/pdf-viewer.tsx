"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
	ExternalLink,
	Highlighter,
	Type,
	Pen,
	Image as ImageIcon,
	MousePointer2,
	Save,
	Loader2,
} from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { withWs } from "@/lib/workspace-client";

// pdf.js component library (same engine as the official viewer) + its CSS.
import * as pdfjsLib from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

// AnnotationEditorType: NONE=0, FREETEXT=3, HIGHLIGHT=9, STAMP=13, INK=15.
const { AnnotationEditorType } = pdfjsLib;

pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";

interface PdfViewerProps {
	path: string;
	title: string;
}

type Tool = {
	mode: number;
	icon: React.ComponentType<{ className?: string }>;
	label: string;
};

const TOOLS: Tool[] = [
	{ mode: AnnotationEditorType.NONE, icon: MousePointer2, label: "Select" },
	{ mode: AnnotationEditorType.HIGHLIGHT, icon: Highlighter, label: "Highlight" },
	{ mode: AnnotationEditorType.FREETEXT, icon: Type, label: "Text" },
	{ mode: AnnotationEditorType.INK, icon: Pen, label: "Draw" },
	{ mode: AnnotationEditorType.STAMP, icon: ImageIcon, label: "Image" },
];

export function PdfViewer({ path, title }: PdfViewerProps) {
	const pdfSrc = withWs(`/api/assets/${path}`);
	const containerRef = useRef<HTMLDivElement>(null);
	const viewerRef = useRef<PDFViewer | null>(null);
	const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

	const [activeTool, setActiveTool] = useState<number>(AnnotationEditorType.NONE);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let cancelled = false;
		let viewer: PDFViewer | null = null;
		let doc: pdfjsLib.PDFDocumentProxy | null = null;

		const eventBus = new EventBus();
		const linkService = new PDFLinkService({ eventBus });
		// annotationEditorMode defaults to NONE (!== DISABLE), which makes the
		// viewer instantiate its AnnotationEditorUIManager so editing works.
		viewer = new PDFViewer({ container, eventBus, linkService });
		linkService.setViewer(viewer);
		viewerRef.current = viewer;

		eventBus.on("pagesinit", () => {
			if (viewer) viewer.currentScaleValue = "page-width";
		});
		// Fires on every annotation create/edit/delete -> mark unsaved.
		eventBus.on("annotationeditorstateschanged", () => {
			if (!cancelled) setDirty(true);
		});

		// ponytail: no cMapUrl/standardFontDataUrl — most PDFs render fine.
		// Add public copies of pdfjs-dist/cmaps + standard_fonts if CJK/embedded
		// fonts render blank.
		pdfjsLib
			.getDocument({ url: pdfSrc })
			.promise.then((loaded) => {
				if (cancelled) {
					loaded.destroy();
					return;
				}
				doc = loaded;
				docRef.current = loaded;
				viewer!.setDocument(loaded);
				linkService.setDocument(loaded, null);
			})
			.catch((e: unknown) => {
				if (!cancelled)
					setLoadError(e instanceof Error ? e.message : "Failed to load PDF");
			});

		return () => {
			cancelled = true;
			viewerRef.current = null;
			docRef.current = null;
			doc?.destroy();
			viewer?.cleanup();
		};
	}, [pdfSrc]);

	const selectTool = useCallback((mode: number) => {
		const viewer = viewerRef.current;
		if (!viewer) return;
		try {
			viewer.annotationEditorMode = { mode };
			setActiveTool(mode);
		} catch {
			/* editor not ready yet */
		}
	}, []);

	const save = useCallback(async () => {
		const doc = docRef.current;
		if (!doc) return;
		setSaving(true);
		setError(null);
		try {
			const bytes = await doc.saveDocument();
			const res = await fetch(
				withWs(`/api/pdf/save?path=${encodeURIComponent(path)}`),
				{
					method: "PUT",
					headers: { "Content-Type": "application/pdf" },
					body: new Blob([bytes as BlobPart], { type: "application/pdf" }),
				},
			);
			if (!res.ok) {
				const j = await res.json().catch(() => ({}));
				throw new Error(j.error === "WORKSPACE_READ_ONLY" ? "Workspace is read-only" : j.error || "Save failed");
			}
			setDirty(false);
		} catch (e: unknown) {
			setError(e instanceof Error ? e.message : "Save failed");
		} finally {
			setSaving(false);
		}
	}, [path]);

	// Warn on navigation away with unsaved annotations.
	useEffect(() => {
		if (!dirty) return;
		const handler = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar path={path} badge="PDF">
				<div className="flex items-center gap-0.5">
					{TOOLS.map((t) => (
						<Button
							key={t.mode}
							variant="ghost"
							size="sm"
							title={t.label}
							className={cn(
								"h-7 w-7 p-0",
								activeTool === t.mode && "bg-accent-soft text-foreground",
							)}
							onClick={() => selectTool(t.mode)}
						>
							<t.icon className="h-3.5 w-3.5" />
						</Button>
					))}
				</div>
				<div className="mx-1 h-4 w-px bg-border" />
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					disabled={!dirty || saving}
					onClick={() => void save()}
					title={dirty ? "Save annotations to file" : "No unsaved changes"}
				>
					{saving ? (
						<Loader2 className="h-3.5 w-3.5 animate-spin" />
					) : (
						<Save className="h-3.5 w-3.5" />
					)}
					{dirty ? "Save*" : "Saved"}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => window.open(pdfSrc, "_blank")}
				>
					<ExternalLink className="h-3.5 w-3.5" />
					Open in new tab
				</Button>
			</ViewerToolbar>
			{error && (
				<div className="bg-destructive/10 px-3 py-1 text-xs text-destructive">{error}</div>
			)}
			{loadError ? (
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					{loadError}
				</div>
			) : (
				<div ref={containerRef} className="absolute-container relative flex-1 overflow-auto bg-muted/30">
					<div className="pdfViewer" />
				</div>
			)}
		</div>
	);
}
