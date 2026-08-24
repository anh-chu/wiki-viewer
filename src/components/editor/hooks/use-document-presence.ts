"use client";

import { useEffect } from "react";
import { wsFetch } from "@/lib/workspace-client";

export type DocumentPresenceMode = "viewing" | "editing";

interface UseDocumentPresenceOptions {
	/** Workspace-scoped root-relative document path. */
	path: string | null;
	/** User interaction mode for the current document. */
	mode: DocumentPresenceMode;
	/** Master switch; when false the hook does nothing. */
	enabled?: boolean;
}

/**
 * Lease an "open" heartbeat for the current Markdown document.
 *
 * - Sends an `open` ping once the user settles on a file for >200ms.
 * - Refreshes the lease every 30s, which is well inside the 90s server TTL.
 * - Sends a `close` beacon on unmount/navigation so the server frees the lease.
 */
export function useDocumentPresence({
	path,
	mode,
	enabled = true,
}: UseDocumentPresenceOptions): void {
	// Editing holds the human-open lease; only viewing stops the heartbeat.
	// Depend on the boolean so toggling view/edit does not close/reopen the lease.
	const isViewingMode = mode === "viewing";

	useEffect(() => {
		if (typeof window === "undefined") return;
		if (!enabled) return;
		if (!path) return;
		if (isViewingMode) return;
		if (!/\.(md|markdown)$/i.test(path)) return;

		const ping = (action: "open" | "heartbeat" | "close") => {
			void wsFetch("/api/wiki/presence", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path, action }),
				keepalive: action === "close",
			}).catch(() => {
				/* presence is best-effort; ignore failures */
			});
		};

		let opened = false;
		let intervalId: ReturnType<typeof setInterval> | null = null;

		const onHidden = () => {
			if (opened && document.visibilityState === "hidden") ping("heartbeat");
		};

		const openTimer = setTimeout(() => {
			opened = true;
			ping("open");
			intervalId = setInterval(() => ping("heartbeat"), 30_000);
			document.addEventListener("visibilitychange", onHidden);
		}, 200);

		return () => {
			clearTimeout(openTimer);
			if (intervalId) clearInterval(intervalId);
			document.removeEventListener("visibilitychange", onHidden);
			if (opened) ping("close");
		};
	}, [enabled, path, isViewingMode]);
}
