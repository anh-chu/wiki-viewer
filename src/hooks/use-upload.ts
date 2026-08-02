"use client";

import { useCallback, useRef, useState } from "react";

import { showError } from "@/lib/toast";
import { wsFetch } from "@/lib/workspace-client";

export function useUpload({
	reloadDir,
}: {
	reloadDir: (dir: string) => Promise<void>;
}) {
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const uploadDirRef = useRef<string>("");

	const doUpload = useCallback(
		async (files: FileList | File[], dir?: string) => {
			if (dir !== undefined) uploadDirRef.current = dir;
			const list = Array.from(files);
			if (!list.length) return;
			setUploading(true);
			setUploadError(null);
			try {
				for (const file of list) {
					const fd = new FormData();
					fd.append("file", file);
					fd.append("dir", uploadDirRef.current);
					const res = await wsFetch("/api/wiki/upload", {
						method: "POST",
						body: fd,
					});
					if (!res.ok) {
						const e: { error?: string } = await res.json();
						setUploadError(e.error ?? "Upload failed");
						showError(e.error ?? "Upload failed");
						break;
					}
				}
				await reloadDir(uploadDirRef.current);
			} catch {
				setUploadError("Upload failed.");
			} finally {
				setUploading(false);
				if (fileInputRef.current) fileInputRef.current.value = "";
			}
		},
		[reloadDir],
	);

	function triggerUpload(dir: string) {
		uploadDirRef.current = dir;
		fileInputRef.current?.click();
	}

	return {
		uploading,
		uploadError,
		fileInputRef,
		triggerUpload,
		doUpload,
	};
}
