"use client";

import { useCallback, useState } from "react";

import { wsFetch } from "@/lib/workspace-client";
import { detectScratchExt } from "@/lib/scratch/detect";
import { showError } from "@/lib/toast";

interface ScratchApi {
	openScratchByPath: (path: string) => void;
	openExternalUrl: (url: string) => void;
	promoteScratch: (destPath: string) => Promise<void> | void;
	openByPath: (path: string) => Promise<boolean> | boolean;
}

interface CreateResult {
	path: string;
	name: string;
}

async function postText(ext: string, content: string): Promise<CreateResult | null> {
	const res = await wsFetch("/api/wiki/scratch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ext, content }),
	});
	if (!res.ok) return null;
	return (await res.json()) as CreateResult;
}

async function postFile(file: File): Promise<CreateResult | null> {
	const form = new FormData();
	form.append("file", file);
	const res = await wsFetch("/api/wiki/scratch", { method: "POST", body: form });
	if (!res.ok) return null;
	return (await res.json()) as CreateResult;
}

export function useScratchpad(doc: ScratchApi) {
	const [creating, setCreating] = useState(false);

	const openCreateSurface = useCallback(() => setCreating(true), []);
	const closeCreateSurface = useCallback(() => setCreating(false), []);

	const createFromText = useCallback(
		async (text: string, extOverride?: string) => {
			if (!text.trim()) return;
			const ext = extOverride ?? detectScratchExt(text);
			const out = await postText(ext, text);
			if (!out) {
				showError("Could not create scratchpad");
				return;
			}
			setCreating(false);
			doc.openScratchByPath(out.path);
		},
		[doc],
	);

	const createFromFile = useCallback(
		async (file: File) => {
			const out = await postFile(file);
			if (!out) {
				showError("Could not create scratchpad");
				return;
			}
			setCreating(false);
			doc.openScratchByPath(out.path);
		},
		[doc],
	);

	const openUrl = useCallback(
		(rawUrl: string) => {
			let url = rawUrl.trim();
			if (!url) return;
			if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
			setCreating(false);
			doc.openExternalUrl(url);
		},
		[doc],
	);

	// One click → empty .scratch/*.excalidraw opened as a blank canvas.
	const createCanvas = useCallback(async () => {
		const out = await postText("excalidraw", "");
		if (!out) {
			showError("Could not create canvas scratchpad");
			return;
		}
		setCreating(false);
		doc.openScratchByPath(out.path);
	}, [doc]);

	// Open an existing workspace file by typed path. The create surface stays
	// open when the target does not exist so the user can fix the path.
	const openPath = useCallback(
		async (rawPath: string) => {
			const p = rawPath.trim();
			if (!p) return;
			const ok = await doc.openByPath(p);
			if (ok) {
				setCreating(false);
			} else {
				showError(`File not found: ${p}`);
			}
		},
		[doc],
	);

	return {
		creating,
		openCreateSurface,
		closeCreateSurface,
		createFromText,
		createFromFile,
		openUrl,
		createCanvas,
		openPath,
	};
}
