"use client";

import { useState } from "react";
import { ArrowLeft, ExternalLink, Play, Ban } from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { withWs } from "@/lib/workspace-client";

interface WebsiteViewerProps {
	path: string;
	title: string;
	/** Override iframe src. Defaults to `/api/assets/{path}/index.html`. */
	src?: string;
	fullscreen?: boolean;
	onExit?: () => void;
}

export function WebsiteViewer({
	path,
	title,
	src,
	fullscreen,
	onExit,
}: WebsiteViewerProps) {
	const [scriptsEnabled, setScriptsEnabled] = useState(false);
	const iframeSrc = withWs(src ?? `/api/assets/${path}/index.html`);

	const sandbox = scriptsEnabled
		? "allow-scripts allow-forms allow-popups allow-top-navigation-by-user-activation"
		: "allow-forms allow-popups allow-top-navigation-by-user-activation";

	const exitButton =
		fullscreen && onExit ? (
			<Button
				variant="ghost"
				size="sm"
				className="h-7 gap-1.5 text-xs"
				onClick={onExit}
				title="Exit app"
			>
				<ArrowLeft className="h-3.5 w-3.5" />
				Exit app
			</Button>
		) : null;

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar
				path={path}
				badge={fullscreen ? "App" : undefined}
				showBreadcrumb={!fullscreen}
				leading={
					fullscreen ? (
						<>
							{exitButton}
							<span className="truncate text-[13px] font-medium text-foreground">
								{title}
							</span>
						</>
					) : null
				}
			>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => setScriptsEnabled((s) => !s)}
					title={
						scriptsEnabled
							? "Disable scripts (recommended for untrusted content)"
							: "Enable scripts"
					}
				>
					{scriptsEnabled ? (
						<>
							<Ban className="h-3.5 w-3.5" />
							Disable scripts
						</>
					) : (
						<>
							<Play className="h-3.5 w-3.5" />
							Enable scripts
						</>
					)}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => window.open(iframeSrc, "_blank")}
				>
					<ExternalLink className="h-3.5 w-3.5" />
					Open in new tab
				</Button>
			</ViewerToolbar>

			<iframe
				src={iframeSrc}
				className="flex-1 w-full border-0 bg-card"
				title={title}
				sandbox={sandbox}
			/>
		</div>
	);
}
