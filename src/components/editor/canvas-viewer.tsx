"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PencilRuler } from "lucide-react";
import { serializeAsJSON } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { wsFetch } from "@/lib/workspace-client";

const EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";
const AUTOSAVE_DELAY_MS = 800;

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
	initialSha: string | null;
	path: string;
	title: string;
}

interface ParsedScene {
	elements: unknown[];
	appState?: Record<string, unknown>;
	files?: BinaryFiles;
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

function stripAppState(appState: Record<string, unknown>): Record<string, unknown> {
	const clean = { ...appState };
	delete clean.theme;
	delete clean.scrollX;
	delete clean.scrollY;
	delete clean.zoom;
	delete clean.selectedElementIds;
	delete clean.editingElement;
	delete clean.resizingElement;
	delete clean.newElement;
	delete clean.multiElement;
	delete clean.selectionElement;
	return clean;
}

function normalizeScene(scene: ParsedScene): string {
	const serialized = serializeAsJSON(
		scene.elements as never,
		(scene.appState ?? {}) as never,
		scene.files ?? {},
		"database",
	);
	const obj = JSON.parse(serialized) as {
		appState?: Record<string, unknown>;
		files?: BinaryFiles;
	};
	if (obj.appState) obj.appState = stripAppState(obj.appState);
	// Excalidraw's database serializer omits binary files; retain them in this
	// workspace snapshot so pasted/dropped images remain embedded in the file.
	if (scene.files && Object.keys(scene.files).length > 0) obj.files = scene.files;
	return JSON.stringify(obj, null, 2);
}

export function CanvasViewer({ content, initialSha, path, title }: CanvasViewerProps) {
	const theme =
		typeof document !== "undefined" &&
		document.documentElement.classList.contains("dark")
			? "dark"
			: "light";
	const scene = useMemo(() => {
		try {
			const value = parseScene(content);
			return { value, normalized: normalizeScene(value), error: null };
		} catch (error) {
			return {
				value: null,
				normalized: "",
				error: error instanceof Error ? error.message : "Invalid canvas JSON.",
			};
		}
	}, [content]);
	const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
	const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
	const [savedContent, setSavedContent] = useState(scene.normalized);
	const savedContentRef = useRef(scene.normalized);
	const [sha, setSha] = useState(initialSha);
	const shaRef = useRef(initialSha);
	const [status, setStatus] = useState<"saving" | "saved" | "reloaded" | "error" | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const savingRef = useRef(false);
	// Set when an edit lands while a save is in flight, so we re-run afterwards
	// instead of silently dropping that edit.
	const rerunRef = useRef(false);
	// Late-bound self-reference so the in-flight re-run and unmount flush can call
	// the latest saveScene without a useCallback dependency cycle.
	const saveSceneRef = useRef<() => void>(() => {});

	useEffect(() => {
		setSavedContent(scene.normalized);
		savedContentRef.current = scene.normalized;
		setSha(initialSha);
		shaRef.current = initialSha;
	}, [initialSha, scene.normalized]);

	const saveScene = useCallback(async () => {
		const currentApi = apiRef.current;
		if (!currentApi) return;
		if (savingRef.current) {
			// A save is already running; remember to run once more when it finishes.
			rerunRef.current = true;
			return;
		}
		savingRef.current = true;
		setStatus("saving");
		setSaveError(null);
		try {
			const json = serializeAsJSON(
				currentApi.getSceneElements(),
				currentApi.getAppState(),
				currentApi.getFiles(),
				"database",
			);
			const obj = JSON.parse(json) as {
				appState?: Record<string, unknown>;
				files?: BinaryFiles;
			};
			if (obj.appState) obj.appState = stripAppState(obj.appState);
			const files = currentApi.getFiles();
			if (Object.keys(files).length > 0) obj.files = files;
			const nextContent = JSON.stringify(obj, null, 2);
			if (nextContent === savedContentRef.current) {
				setStatus("saved");
				return;
			}

			const response = await wsFetch("/api/wiki/content", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path, content: nextContent, baseSha: shaRef.current }),
			});
			if (response.ok) {
				const result = (await response.json()) as { sha?: string };
				savedContentRef.current = nextContent;
				setSavedContent(nextContent);
				shaRef.current = result.sha ?? shaRef.current;
				setSha(shaRef.current);
				setStatus("saved");
				return;
			}

			const result = (await response.json()) as { error?: string };
			if (response.status === 409 && result.error === "STALE_SHA") {
				const reload = await wsFetch(`/api/wiki/content?path=${encodeURIComponent(path)}`);
				if (!reload.ok) throw new Error("Could not reload canvas after conflict.");
				const data = (await reload.json()) as { content: string };
				const freshScene = parseScene(data.content);
				const freshNormalized = normalizeScene(freshScene);
				currentApi.updateScene({
					elements: freshScene.elements as never,
					appState: stripAppState(freshScene.appState ?? {}) as never,
				});
				if (freshScene.files) currentApi.addFiles(Object.values(freshScene.files));
				savedContentRef.current = freshNormalized;
				setSavedContent(freshNormalized);
				shaRef.current = reload.headers.get("X-Wiki-Sha256");
				setSha(shaRef.current);
				setStatus("reloaded");
				return;
			}
			throw new Error(result.error ?? "Save failed");
		} catch (error) {
			setSaveError(error instanceof Error ? error.message : "Save failed");
			setStatus("error");
		} finally {
			savingRef.current = false;
			if (rerunRef.current) {
				rerunRef.current = false;
				saveTimerRef.current = setTimeout(() => {
					saveTimerRef.current = null;
					saveSceneRef.current();
				}, AUTOSAVE_DELAY_MS);
			}
		}
	}, [path]);

	saveSceneRef.current = saveScene;

	const scheduleSave = useCallback(() => {
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveTimerRef.current = null;
			void saveScene();
		}, AUTOSAVE_DELAY_MS);
	}, [saveScene]);

	useEffect(
		() => () => {
			// Flush a pending debounced edit on unmount so closing the file right
			// after drawing does not drop the last change.
			if (saveTimerRef.current) {
				clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
				saveSceneRef.current();
			}
		},
		[],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<ViewerToolbar path={path} badge="CANVAS">
				<span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
					<PencilRuler className="h-3.5 w-3.5 text-violet-500" />
					{status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "reloaded" ? "Reloaded" : "Editable"}
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
						excalidrawAPI={(instance) => {
							apiRef.current = instance;
							setApi(instance);
						}}
						onChange={() => {
							if (api) scheduleSave();
						}}
						theme={theme}
						name={title}
						autoFocus={false}
					/>
					{saveError && <p className="px-3 py-1 text-xs text-destructive">{saveError}</p>}
				</div>
			)}
		</div>
	);
}
