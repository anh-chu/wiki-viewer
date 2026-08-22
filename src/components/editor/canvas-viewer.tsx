"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { PencilRuler } from "lucide-react";
import "@excalidraw/excalidraw/index.css";

import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";

const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

if (typeof window !== "undefined") {
	(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
		EXCALIDRAW_ASSET_PATH;
}

const Excalidraw = dynamic(
	() => import("@excalidraw/excalidraw").then((module) => module.Excalidraw),
	{
		ssr: false,
		loading: () => (
			<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
				Loading canvas…
			</div>
		),
	},
);

interface CanvasViewerProps {
	content: string | null;
	path: string;
	title: string;
}

interface ParsedScene {
	elements: unknown[];
	[key: string]: unknown;
}

function parseScene(content: string | null): ParsedScene {
	if (content === null) throw new Error("Canvas file could not be loaded.");
	// A newly created / empty file is a valid blank canvas, not an error.
	if (content.trim() === "") return { elements: [] };
	const parsed: unknown = JSON.parse(content);
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { elements?: unknown }).elements)) {
		throw new Error("Canvas JSON must contain an elements array.");
	}
	return parsed as ParsedScene;
}

export function CanvasViewer({ content, path, title }: CanvasViewerProps) {
	const theme =
		typeof document !== "undefined" &&
		document.documentElement.classList.contains("dark")
			? "dark"
			: "light";
	const scene = useMemo(() => {
		try {
			return { value: parseScene(content), error: null };
		} catch (error) {
			return {
				value: null,
				error: error instanceof Error ? error.message : "Invalid canvas JSON.",
			};
		}
	}, [content]);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<ViewerToolbar path={path} badge="CANVAS">
				<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
					<PencilRuler className="h-3.5 w-3.5 text-violet-500" />
					Read-only
				</span>
			</ViewerToolbar>
			{scene.error ? (
				<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
					<PencilRuler className="h-10 w-10 text-destructive" />
					<p className="font-medium text-destructive">Could not render canvas</p>
					<p className="max-w-lg text-sm text-muted-foreground">{scene.error}</p>
					<Button variant="outline" size="sm" onClick={() => window.location.reload()}>
						Reload
					</Button>
				</div>
			) : (
				<div className="min-h-0 flex-1 bg-background">
					<Excalidraw
						initialData={scene.value as never}
						viewModeEnabled
						theme={theme}
						name={title}
						autoFocus={false}
					/>
				</div>
			)}
		</div>
	);
}
