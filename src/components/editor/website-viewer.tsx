"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Play, Ban, Server } from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { assetPreviewUrl, previewAssetUrl } from "@/lib/workspace-client";
import { kebabCase, useHostedAppsStore } from "@/stores/hosted-apps-store";

interface WebsiteViewerProps {
	path: string;
	title: string;
	/**
	 * Root-relative file to preview. Defaults to `${path}/index.html`, which is
	 * what a directory-backed app serves.
	 */
	previewRel?: string;
	/** Absolute external URL (scratch view). Takes precedence over previewRel. */
	externalUrl?: string;
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
	previewRel,
	externalUrl,
	fullscreen,
	onExit,
	scriptsEnabled: scriptsEnabledProp,
	onToggleScripts,
}: WebsiteViewerProps) {
	const [scriptsEnabledState, setScriptsEnabledState] = useState(false);
	const scriptsEnabled = scriptsEnabledProp ?? scriptsEnabledState;
	const toggleScripts = onToggleScripts ?? (() => setScriptsEnabledState((s) => !s));

	// The preview gets a capability token so the frames and assets the previewed
	// document loads stay authorized from its transient origin (see
	// previewAssetUrl). Start from the cookie-scoped URL so a preview is never
	// blank while the token is minted, or when minting fails.
	const rel = previewRel ?? `${path}/index.html`;
	const [iframeSrc, setIframeSrc] = useState(externalUrl ?? assetPreviewUrl(rel));
	useEffect(() => {
		if (externalUrl) {
			setIframeSrc(externalUrl);
			return;
		}
		let live = true;
		void previewAssetUrl(rel).then((url) => {
			if (live) setIframeSrc(url);
		});
		return () => {
			live = false;
		};
	}, [rel, externalUrl]);

	// The sandbox never combines allow-scripts with allow-same-origin. The
	// preview therefore always has a transient origin; nested local files load
	// because /api/assets omits X-Frame-Options and their URLs carry the
	// directory-scoped preview token (src/lib/preview-token.ts). Neither toggle
	// state may add allow-same-origin — that is the security boundary in
	// docs/ux-contracts.md 3.2.
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
					onClick={() =>
						useHostedAppsStore
							.getState()
							.openHostDialog(path, kebabCase(path.split("/").pop() ?? path))
					}
					title="Host this app under a short slug"
				>
					<Server className="h-3.5 w-3.5" />
					Host this app
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
					key={scriptsEnabled ? "scripts-on" : "scripts-off"}
					src={iframeSrc}
					className="flex-1 w-full border-0 bg-card"
					title={title}
					sandbox={sandbox}
				/>
			</div>
		</div>
	);
}
