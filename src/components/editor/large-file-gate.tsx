"use client";

import { Download, ExternalLink, FileWarning, FolderOpen } from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { withWs, wsFetch } from "@/lib/workspace-client";

interface LargeFileGateProps {
	path: string;
	size: number;
	/** Mount the real viewer. */
	onOpen: () => void;
}

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

/**
 * Confirmation shown before mounting a viewer that loads and renders a whole
 * large file. Sits above the viewer dispatch, so it guards every unsafe viewer
 * in one place. The user can open it anyway, download it, or open the raw bytes.
 */
export function LargeFileGate({ path, size, onOpen }: LargeFileGateProps) {
	const assetUrl = withWs(`/api/assets/${path}`);
	const filename = path.split("/").pop() || path;
	const ext = filename.includes(".")
		? filename.split(".").pop()?.toUpperCase()
		: "";

	const revealInFinder = async () => {
		try {
			await wsFetch("/api/system/reveal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path }),
			});
		} catch {
			/* ignore */
		}
	};

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar path={path} badge={ext || undefined} />
			<div className="flex-1 flex items-center justify-center">
				<div className="flex flex-col items-center gap-4 text-center max-w-sm">
					<div className="flex size-16 items-center justify-center rounded-2xl bg-amber-500/10">
						<FileWarning className="size-8 text-amber-500" />
					</div>
					<div className="space-y-1">
						<p className="text-sm font-medium">{filename}</p>
						<p className="text-xs text-muted-foreground">
							This file is {formatSize(size)}. Opening it in the viewer may
							freeze the tab while it loads and renders.
						</p>
					</div>
					<div className="flex flex-wrap items-center justify-center gap-2">
						<Button
							variant="default"
							size="sm"
							className="gap-2"
							onClick={onOpen}
						>
							Open anyway
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="gap-2"
							onClick={() => window.open(assetUrl, "_blank")}
						>
							<ExternalLink className="h-4 w-4" />
							Raw
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="gap-2"
							onClick={() => {
								const a = document.createElement("a");
								a.href = assetUrl;
								a.download = filename;
								a.click();
							}}
						>
							<Download className="h-4 w-4" />
							Download
						</Button>
						<Button
							variant="outline"
							size="sm"
							className="gap-2"
							onClick={revealInFinder}
						>
							<FolderOpen className="h-4 w-4" />
							Open in Finder
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
