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
	/**
	 * Controlled scripts-enabled state. Lifted to the parent (viewer-pane) so
	 * the toggle survives the header's Refresh action, which remounts this
	 * component via a changing `key`. Falls back to internal state when not
	 * provided (e.g. if used standalone elsewhere).
	 */
	scriptsEnabled?: boolean;
	onToggleScripts?: () => void;
}

export function WebsiteViewer({
	path,
	title,
	src,
	fullscreen,
	onExit,
	scriptsEnabled: scriptsEnabledProp,
	onToggleScripts,
}: WebsiteViewerProps) {
	const [scriptsEnabledState, setScriptsEnabledState] = useState(false);
	const scriptsEnabled = scriptsEnabledProp ?? scriptsEnabledState;
	const toggleScripts = onToggleScripts ?? (() => setScriptsEnabledState((s) => !s));
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
					onClick={toggleScripts}
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

			<div className="relative flex-1 flex overflow-hidden">
				<iframe
					src={iframeSrc}
					className="flex-1 w-full border-0 bg-card"
					title={title}
					sandbox={sandbox}
				/>
			</div>
		</div>
	);
}
