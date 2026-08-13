"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { markdownToHtml } from "@/lib/markdown/to-html";
import { apiUrl } from "@/lib/url-prefix";
import {
	getEphemeralRoot,
	toRootRelative,
	wsFetch,
} from "@/lib/workspace-client";
import { useEditorStore } from "@/stores/editor-store";
import { useRecentStore } from "@/stores/recent-store";
import type { FileTreeNode, OpenFile } from "@/types/wiki";

import {
	fetchDir,
	TreeNode as FileTreeHookNode,
} from "@/hooks/use-file-tree";
import {
	isMarkdown,
	isText,
	viewerKindFor,
} from "@/components/wiki/file-tree";
import { showError, showSuccess } from "@/lib/toast";

export type TreeNode = FileTreeNode;

interface TreeApi {
	revealPath: (p: string) => Promise<void>;
	toggleFolder: (n: TreeNode) => Promise<void>;
}

export interface UseOpenFileOptions {
	activeWorkspaceId: string | null;
	rootPath: string | null;
	isMobile: boolean;
	setSidebarCollapsed: (v: boolean) => void;
	treeApi: TreeApi;
}

export function useOpenFile({
	activeWorkspaceId,
	rootPath,
	isMobile,
	setSidebarCollapsed,
	treeApi,
}: UseOpenFileOptions) {
	const [openFile, setOpenFile] = useState<OpenFile | null>(null);
	const [gateBypassPath, setGateBypassPath] = useState<string | null>(null);
	const [appFullscreen, setAppFullscreen] = useState(false);
	const [appKey, setAppKey] = useState(0);
	const [viewerKey, setViewerKey] = useState(0);
	const [fileContent, setFileContent] = useState<string | null>(null);
	const [fileRevision, setFileRevision] = useState(0);
	const [fileLoading, setFileLoading] = useState(false);
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [htmlSourceMode, setHtmlSourceMode] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const openFileRef = useRef<OpenFile | null>(null);
	const editingRef = useRef(false);
	useEffect(() => {
		openFileRef.current = openFile;
	}, [openFile]);
	useEffect(() => {
		editingRef.current = editing;
	}, [editing]);

	const openFileViewerKind = useMemo(
		() => (openFile ? viewerKindFor(openFile.name, openFile.nodeType) : null),
		[openFile],
	);

	const resetFileState = useCallback(() => {
		setEditing(false);
		setHtmlSourceMode(false);
		setSaveError(null);
		setFileContent(null);
		setFileRevision(0);
		setGateBypassPath(null);
	}, []);

	const loadContent = useCallback(
		async (path: string, kind: ReturnType<typeof viewerKindFor>) => {
			if (!["editor", "text"].includes(kind) && !isText(nameFromPath(path))) {
				return;
			}
			setFileLoading(true);
			try {
				const res = await wsFetch(
					`/api/wiki/content?path=${encodeURIComponent(path)}`,
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
		},
		[],
	);

	const openViewer = useCallback(
		async (node: TreeNode) => {
			if (node.type === "file") {
				useRecentStore
					.getState()
					.push(
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
			resetFileState();
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
			await loadContent(node.path, kind);
		},
		[activeWorkspaceId, resetFileState, loadContent],
	);

	const openScratchByPath = useCallback(
		(relPath: string) => {
			const name = relPath.split("/").pop() ?? relPath;
			void openViewer({
				path: relPath,
				name,
				type: "file",
				modifiedAt: "",
			} as TreeNode);
		},
		[openViewer],
	);

	const openExternalUrl = useCallback(
		(url: string) => {
			resetFileState();
			setOpenFile({
				path: "",
				name: url,
				nodeType: "app",
				externalUrl: url,
			});
		},
		[resetFileState],
	);

	const promoteScratch = useCallback(
		async (destPath: string) => {
			const from = openFileRef.current?.path;
			if (!from) return;
			try {
				const res = await wsFetch("/api/wiki/move", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ from, to: destPath }),
				});
				if (!res.ok) {
					showError("Could not save scratch to file");
					return;
				}
				showSuccess("Saved to file");
				const name = destPath.split("/").pop() ?? destPath;
				await treeApi.revealPath(destPath);
				void openViewer({
					path: destPath,
					name,
					type: "file",
					modifiedAt: "",
				} as TreeNode);
			} catch {
				showError("Could not save scratch to file");
			}
		},
		[openViewer, treeApi],
	);

	const closeFile = useCallback(() => {
		setOpenFile(null);
		setFileContent(null);
		setEditing(false);
		setHtmlSourceMode(false);
		setSaveError(null);
	}, []);

	const clearFile = useCallback(() => {
		setOpenFile(null);
		setFileContent(null);
		setEditing(false);
		setHtmlSourceMode(false);
		setSaveError(null);
		setFileRevision(0);
	}, []);

	const openFromSearch = useCallback(
		(relPath: string) => {
			const name = relPath.split("/").pop() ?? relPath;
			void treeApi.revealPath(relPath);
			void openViewer({
				path: relPath,
				name,
				type: "file",
				modifiedAt: "",
			} as TreeNode);
		},
		[openViewer, treeApi],
	);

	const openFavoriteEntry = useCallback(
		async (p: { path: string; name: string; type?: string }) => {
			const parentDir = p.path.split("/").slice(0, -1).join("/");
			const siblings = await fetchDir(parentDir);
			const match = siblings.find((s) => s.path === p.path);
			if (!match) return;
			if (match.type === "dir") {
				await treeApi.revealPath(p.path);
				await treeApi.toggleFolder(match);
				return;
			}
			if (match.type === "app" || match.type === "node-app") {
				await treeApi.revealPath(match.path);
				void openViewer({
					path: match.path,
					name: match.name,
					type: match.type,
					modifiedAt: match.modifiedAt,
				} as TreeNode);
				await treeApi.toggleFolder(match);
				if (isMobile) setSidebarCollapsed(true);
				return;
			}
			void openViewer({
				path: match.path,
				name: match.name,
				type: match.type,
				modifiedAt: match.modifiedAt,
			} as TreeNode);
			if (isMobile) setSidebarCollapsed(true);
		},
		[isMobile, openViewer, setSidebarCollapsed, treeApi],
	);

	const navigateToPath = useCallback(
		async (target: string | null) => {
			if (!target) {
				setOpenFile(null);
				return;
			}
			const rel = toRootRelative(
				target,
				getEphemeralRoot() ?? rootPath,
			);
			if (rel === null) return;
			target = rel;
			if (!target) return;
			const parts = target.split("/");
			const name = parts[parts.length - 1];
			const parentDir = parts.slice(0, -1).join("/");
			const siblings = await fetchDir(parentDir);
			const match = siblings.find((s) => s.path === target);
			if (!match) return;
			if (match.type === "dir") {
				await treeApi.revealPath(target);
				await treeApi.toggleFolder(match);
				setOpenFile(null);
				return;
			}
			await treeApi.revealPath(target);
			void openViewer({
				path: target,
				name,
				type: match.type,
				modifiedAt: match.modifiedAt,
			} as TreeNode);
		},
		[openViewer, rootPath, treeApi],
	);

	// Persist the open file to the URL so reloads restore it. File-backed views
	// use ?path=; external-URL scratch views use ?url= (they have no path).
	useEffect(() => {
		if (typeof window === "undefined") return;
		const url = new URL(window.location.href);
		if (openFile?.externalUrl) {
			url.searchParams.set("url", openFile.externalUrl);
			url.searchParams.delete("path");
		} else if (openFile) {
			url.searchParams.set("path", openFile.path);
			url.searchParams.delete("url");
		} else {
			url.searchParams.delete("path");
			url.searchParams.delete("url");
		}
		const next = url.toString();
		if (next === window.location.href) return;
		window.history.pushState(null, "", next);
	}, [openFile]);

	// Browser back/forward.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onPop = () => {
			const sp = new URLSearchParams(window.location.search);
			const u = sp.get("url");
			if (u) {
				openExternalUrl(u);
				return;
			}
			void navigateToPath(sp.get("path"));
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [navigateToPath, openExternalUrl]);

	// Embed postMessage listener.
	const [isEmbed, setIsEmbed] = useState(false);
	useEffect(() => {
		const sp = new URLSearchParams(window.location.search);
		setIsEmbed(sp.get("embed") === "1");
	}, []);
	useEffect(() => {
		if (!isEmbed) return;
		const handler = (e: MessageEvent) => {
			if (e.origin !== window.location.origin) {
				console.warn(
					`[wiki-viewer] ignored postMessage from untrusted parent origin ${e.origin}.`,
				);
				return;
			}
			if (
				!e.data ||
				e.data.type !== "open-file" ||
				typeof e.data.path !== "string"
			)
				return;
			void navigateToPath(e.data.path);
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [isEmbed, navigateToPath]);

	// Restore from URL once the root tree is loaded.
	const initialUrlPathRef = useRef<string | null>(
		typeof window !== "undefined"
			? new URLSearchParams(window.location.search).get("path") ??
			  new URLSearchParams(window.location.search).get("file")
			: null,
	);
	const initialUrlExternalRef = useRef<string | null>(
		typeof window !== "undefined"
			? new URLSearchParams(window.location.search).get("url")
			: null,
	);
	const didRestoreRef = useRef(false);
	const [rootLoadedTrigger, setRootLoadedTrigger] = useState(false);
	const markRootLoaded = useCallback(() => setRootLoadedTrigger(true), []);
	useEffect(() => {
		if (didRestoreRef.current) return;
		if (!rootLoadedTrigger) return;
		didRestoreRef.current = true;
		if (initialUrlExternalRef.current) {
			openExternalUrl(initialUrlExternalRef.current);
			return;
		}
		void navigateToPath(initialUrlPathRef.current);
	}, [rootLoadedTrigger, navigateToPath, openExternalUrl]);

	// Sync the editor store to the open markdown file.
	useEffect(() => {
		if (!openFile || !isMarkdown(openFile.name)) return;
		if (useEditorStore.getState().currentPath === openFile.path) return;
		void useEditorStore.getState().loadPage(openFile.path);
	}, [openFile]);

	const refreshViewer = useCallback(async () => {
		const current = openFileRef.current;
		if (!current) return;
		if (isMarkdown(current.name)) {
			setFileLoading(true);
			try {
				await useEditorStore.getState().loadPage(current.path);
			} finally {
				setFileLoading(false);
			}
			return;
		}
		const kind = viewerKindFor(current.name, current.nodeType);
		if (!["editor", "text"].includes(kind) && !isText(current.name)) return;
		setFileLoading(true);
		try {
			const res = await wsFetch(
				`/api/wiki/content?path=${encodeURIComponent(current.path)}`,
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
	}, []);

	const handleRefresh = useCallback(() => {
		setViewerKey((k) => k + 1);
		void refreshViewer();
	}, [refreshViewer]);

	const onExternalChange = useCallback((relPath: string) => {
		const current = openFileRef.current;
		if (!current || current.path !== relPath || editingRef.current) return;
		void refreshViewer();
	}, [refreshViewer]);

	const handleSave = useCallback(async () => {
		const current = openFileRef.current;
		if (!current) return;
		setSaving(true);
		setSaveError(null);
		const res = await wsFetch("/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: current.path,
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
	}, [editContent, fileRevision]);

	async function getTextContent(path: string) {
		const current = openFileRef.current;
		if (current?.path === path && fileContent !== null) return fileContent;
		if (useEditorStore.getState().currentPath === path) {
			return useEditorStore.getState().content;
		}
		const res = await wsFetch(
			`/api/wiki/content?path=${encodeURIComponent(path)}`,
		);
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
			const html = await markdownToHtml(content, {
				pagePath: path,
				sanitize: true,
			});
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

	return {
		openFile,
		openFileViewerKind,
		fileContent,
		fileRevision,
		fileLoading,
		editing,
		setEditing,
		editContent,
		setEditContent,
		htmlSourceMode,
		setHtmlSourceMode,
		saving,
		saveError,
		appFullscreen,
		setAppFullscreen,
		appKey,
		setAppKey,
		viewerKey,
		setViewerKey,
		gateBypassPath,
		bypassGate: () => setGateBypassPath(openFileRef.current?.path ?? null),
		openViewer,
		openScratchByPath,
		openExternalUrl,
		promoteScratch,
		openFromSearch,
		openFavoriteEntry,
		navigateToPath,
		handleSave,
		refreshViewer,
		handleRefresh,
		closeFile,
		clearFile,
		onExternalChange,
		markRootLoaded,
		copyPath: (path: string) => {
			void navigator.clipboard.writeText(path);
			showSuccess("Path copied");
		},
		copyWikiLink: (name: string) => {
			const slug = name.replace(/\.(md|markdown)$/i, "");
			void navigator.clipboard.writeText(`[[${slug}]]`);
			showSuccess("Wiki link copied");
		},
		copyUrl: (path: string) => {
			const url = new URL(location.href);
			url.searchParams.set("path", path);
			if (activeWorkspaceId) url.searchParams.set("ws", activeWorkspaceId);
			void navigator.clipboard.writeText(url.toString());
			showSuccess("URL copied");
		},
		copyRawContent,
		copyFormattedContent,
	};
}

function nameFromPath(p: string) {
	return p.split("/").pop() ?? p;
}
