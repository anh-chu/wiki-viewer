"use client";

import { Play, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppStatus } from "@/lib/app-runner";
import { cn } from "@/lib/utils";
import { wsFetch } from "@/lib/workspace-client";

interface Props {
	activeWorkspaceId: string | null;
	workspaceName: string;
	openPath: string | null;
	onOpen: () => void;
}

/**
 * Launch affordance for a workspace whose ROOT directory is itself a node app.
 * The root has no tree entry of its own, so without this bar there is no way to
 * reach the node-app viewer for it. Clicking opens the root in the node-app
 * viewer (path ""), which handles install/launch/logs/host.
 */
export function RootAppBar({ activeWorkspaceId, workspaceName, openPath, onOpen }: Props) {
	const [isNodeApp, setIsNodeApp] = useState(false);
	const [status, setStatus] = useState<AppStatus | null>(null);

	useEffect(() => {
		if (!activeWorkspaceId) return;
		let cancelled = false;
		void (async () => {
			try {
				const res = await wsFetch("/api/wiki/app?path=");
				if (!res.ok) return;
				const data: { isNodeApp?: boolean; status?: AppStatus } = await res.json();
				if (cancelled) return;
				setIsNodeApp(Boolean(data.isNodeApp));
				setStatus(data.status ?? null);
			} catch {
				// non-fatal: bar simply stays hidden
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [activeWorkspaceId]);

	if (!isNodeApp) return null;

	const active = openPath === "";
	const running = status === "running";

	return (
		<div className="border-b mb-1 px-2 py-1.5">
			<button
				type="button"
				onClick={onOpen}
				className={cn(
					"group flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-sm transition-colors",
					active ? "bg-accent-soft text-foreground font-medium" : "hover:bg-muted",
				)}
			>
				<Terminal className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
				<span className="min-w-0 flex-1 truncate text-left text-xs">
					{workspaceName}
				</span>
				{running ? (
					<span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Running" />
				) : (
					<Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
				)}
			</button>
		</div>
	);
}
