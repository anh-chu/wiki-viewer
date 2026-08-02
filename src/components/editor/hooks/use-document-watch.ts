"use client";

import { useEffect, useMemo } from "react";
import {
	withWs,
	getActiveWorkspaceId,
	getEphemeralRoot,
} from "@/lib/workspace-client";
import { isLite } from "@/lib/url-prefix";
import { useProofStore } from "@/stores/proof-store";
import { useEditorStore } from "@/stores/editor-store";

interface UseDocumentWatchOptions {
	/** Workspace-scoped root-relative path of the open document. */
	path: string | null;
	/** Ref to whether the editor is currently in viewing mode. */
	isViewingRef: React.MutableRefObject<boolean>;
	/** Master switch; disables the watcher entirely when false. */
	enabled?: boolean;
}

/**
 * Subscribe to filesystem changes for the open file's parent directory.
 *
 * The watcher deliberately covers the parent directory, not the file itself,
 * because chokidar reports file events relative to the watched directory and
 * an empty relative path is ignored as a root event. A `rescan` or `degraded`
 * event reloads the snapshot and sidecar because anything may have changed
 * while the watcher was down.
 *
 * The subscription is recreated on path or workspace changes so events never
 * bleed across documents or workspaces. Lite mode has no watcher.
 */
export function useDocumentWatch({
	path,
	isViewingRef,
	enabled = true,
}: UseDocumentWatchOptions): void {
	const watchDir = useMemo(() => {
		if (!path) return "";
		const i = path.lastIndexOf("/");
		return i === -1 ? "" : path.slice(0, i);
	}, [path]);

	const workspaceId = getActiveWorkspaceId();
	const ephemeralRoot = getEphemeralRoot();

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (!enabled) return;
		if (isLite()) return;
		if (!path) return;

		const refreshOpen = (activePath: string) => {
			// loadSnapshot first so the server detects a fingerprint mismatch,
			// emits file.externallyEdited, and persists the sidecar. Then
			// loadSidecar refreshes comments/suggestions.
			void useProofStore
				.getState()
				.loadSnapshot(activePath)
				.then(() => useProofStore.getState().loadSidecar(activePath));
			if (isViewingRef.current) {
				void useEditorStore.getState().loadPage(activePath);
			}
		};

		const url = watchDir
			? `/api/wiki/watch?dir=${encodeURIComponent(watchDir)}`
			: "/api/wiki/watch";
		const es = new EventSource(withWs(url));

		es.onmessage = (evt: MessageEvent<string>) => {
			try {
				const data = JSON.parse(evt.data) as { type: string; path: string };
				const activePath = useEditorStore.getState().currentPath;
				if (!activePath) return;

				if (data.type === "rescan") {
					refreshOpen(activePath);
					return;
				}
				if (
					(data.type === "change" || data.type === "add") &&
					data.path === activePath
				) {
					refreshOpen(activePath);
				}
			} catch {
				// ignore malformed events
			}
		};

		return () => {
			es.close();
		};
	}, [path, watchDir, enabled, workspaceId, ephemeralRoot, isViewingRef]);
}
