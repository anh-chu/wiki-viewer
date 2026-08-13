"use client";

import { useCallback, useState } from "react";

import { wsFetch } from "@/lib/workspace-client";
import { detectScratchExt } from "@/lib/scratch/detect";
import { showError } from "@/lib/toast";

interface ScratchApi {
	openScratchByPath: (path: string) => void;
	openExternalUrl: (url: string) => void;
	promoteScratch: (destPath: string) => Promise<void> | void;
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

	return {
		creating,
		openCreateSurface,
		closeCreateSurface,
		createFromText,
		createFromFile,
		openUrl,
	};
}
