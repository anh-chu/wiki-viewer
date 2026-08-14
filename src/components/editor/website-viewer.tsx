"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Play, Ban, MousePointerClick } from "lucide-react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import { WebTweakOverlay } from "@/components/editor/web-tweak-overlay";
import { injectPicker } from "@/lib/web-tweak/picker";
import { withWs, wsFetch } from "@/lib/workspace-client";

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

	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const [tweakEnabled, setTweakEnabled] = useState(false);
	const [tweakHtml, setTweakHtml] = useState<string | null>(null);
	const [tweakError, setTweakError] = useState<string | null>(null);

	// Fetch the raw HTML and inject the picker when tweak mode turns on.
	useEffect(() => {
		if (!tweakEnabled) {
			setTweakHtml(null);
			setTweakError(null);
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const res = await wsFetch(src ?? `/api/assets/${path}/index.html`);
				if (!alive) return;
				if (!res.ok) {
					setTweakError("Could not load page for tweaking.");
					return;
				}
				const html = await res.text();
				if (!alive) return;
				setTweakHtml(injectPicker(html));
			} catch {
				if (alive) setTweakError("Could not load page for tweaking.");
			}
		})();
		return () => {
			alive = false;
		};
	}, [tweakEnabled, src, path]);

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
					className={`h-7 gap-1.5 text-xs${tweakEnabled ? " text-primary" : ""}`}
					onClick={() => setTweakEnabled((t) => !t)}
					title={tweakEnabled ? "Exit tweak mode" : "Tweak this page"}
				>
					<MousePointerClick className="h-3.5 w-3.5" />
					Tweak
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
				{tweakEnabled ? (
					tweakHtml ? (
						<iframe
							ref={frameRef}
							srcDoc={tweakHtml}
							className="flex-1 w-full border-0 bg-card"
							title={title}
							sandbox="allow-scripts"
						/>
					) : (
						<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
							{tweakError ?? "Loading page for tweaking…"}
						</div>
					)
				) : (
					<iframe
						src={iframeSrc}
						className="flex-1 w-full border-0 bg-card"
						title={title}
						sandbox={sandbox}
					/>
				)}
				{tweakEnabled && tweakHtml && (
					<WebTweakOverlay
						frameRef={frameRef}
						path={path}
						enabled={tweakEnabled}
						onClose={() => setTweakEnabled(false)}
					/>
				)}
			</div>
		</div>
	);
}
