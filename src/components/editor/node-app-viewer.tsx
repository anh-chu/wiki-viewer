"use client";

import {
	AlertCircle,
	ChevronDown,
	ExternalLink,
	Loader2,
	Play,
	RefreshCw,
	Square,
	Terminal,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ViewerToolbar } from "@/components/layout/viewer-toolbar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AppStatus } from "@/lib/app-runner";
import { wsFetch } from "@/lib/workspace-client";

interface Props {
	path: string;
	title: string;
}

interface StatusResponse {
	status: AppStatus;
	port?: number;
	error?: string;
	logs: string[];
	scripts?: string[];
	defaultScript?: string | null;
}

const STATUS_LABEL: Record<AppStatus, string> = {
	stopped: "Stopped",
	installing: "Installing dependencies…",
	starting: "Starting…",
	running: "Running",
	error: "Error",
};

export function NodeAppViewer({ path, title }: Props) {
	const [status, setStatus] = useState<AppStatus>("stopped");
	const [port, setPort] = useState<number | null>(null);
	const [logs, setLogs] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [showLogs, setShowLogs] = useState(false);
	const [iframeKey, setIframeKey] = useState(0);
	const [scripts, setScripts] = useState<string[]>([]);
	const [defaultScript, setDefaultScript] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const logsEndRef = useRef<HTMLDivElement>(null);

	// Proxy URL — all traffic flows through wiki-viewer (works remotely)
	const proxyUrl = `/api/app-proxy/${path}/`;

	const stopPolling = () => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	};

	const fetchStatus = useCallback(async () => {
		try {
			const res = await wsFetch(`/api/wiki/app?path=${encodeURIComponent(path)}`);
			if (!res.ok) return;
			const data: StatusResponse = await res.json();
			setStatus(data.status);
			setLogs(data.logs ?? []);
			if (data.scripts) setScripts(data.scripts);
			if (data.defaultScript !== undefined) setDefaultScript(data.defaultScript);
			if (data.port) setPort(data.port);
			if (data.error) setError(data.error);
			if (data.status === "running" || data.status === "stopped" || data.status === "error") {
				stopPolling();
			}
		} catch {}
	}, [path]);

	// Poll while in transient states
	useEffect(() => {
		if (status === "installing" || status === "starting") {
			if (!pollRef.current) {
				pollRef.current = setInterval(fetchStatus, 800);
			}
		} else {
			stopPolling();
		}
		return stopPolling;
	}, [status, fetchStatus]);

	// Auto-scroll logs
	useEffect(() => {
		logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [logs]);

	// Fetch current status on mount (app may already be running)
	useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	const handleLaunch = async (script?: string) => {
		setError(null);
		setLogs([]);
		setStatus("starting");
		try {
			const res = await wsFetch("/api/wiki/app", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path, script }),
			});
			const data: { port?: number; error?: string } = await res.json();
			if (!res.ok || data.error) {
				setStatus("error");
				setError(data.error ?? "Failed to start");
				return;
			}
			if (data.port) setPort(data.port);
			// Start polling for readiness
			await fetchStatus();
		} catch (e) {
			setStatus("error");
			setError(String(e));
		}
	};

	const handleStop = async () => {
		await wsFetch("/api/wiki/app", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
		setStatus("stopped");
		setPort(null);
	};

	const handleRestart = async () => {
		await handleStop();
		await handleLaunch();
		setIframeKey((k) => k + 1);
	};

	const isTransient = status === "installing" || status === "starting";
	// Scripts other than the default — offered in the combo dropdown.
	const altScripts = scripts.filter((s) => s !== defaultScript);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			<ViewerToolbar path={path} badge="Node app">
				{status === "running" && (
					<>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 text-xs"
							onClick={() => setIframeKey((k) => k + 1)}
						>
							<RefreshCw className="h-3.5 w-3.5" />
							Refresh
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 text-xs"
							onClick={() => window.open(proxyUrl, "_blank")}
						>
							<ExternalLink className="h-3.5 w-3.5" />
							Open in new tab
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 text-xs"
							onClick={handleRestart}
						>
							<RefreshCw className="h-3.5 w-3.5" />
							Restart
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
							onClick={handleStop}
						>
							<Square className="h-3.5 w-3.5" />
							Stop
						</Button>
					</>
				)}
				<Button
					variant="ghost"
					size="sm"
					className="h-7 gap-1.5 text-xs"
					onClick={() => setShowLogs((v) => !v)}
				>
					<Terminal className="h-3.5 w-3.5" />
					Logs
				</Button>
			</ViewerToolbar>

			{/* Logs panel */}
			{showLogs && (
				<div className="border-b bg-black/90 text-green-400 font-mono text-xs h-40 overflow-auto p-2 shrink-0">
					{logs.length === 0 ? (
						<span className="text-muted-foreground">No output yet.</span>
					) : (
						logs.map((l, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only
							<div key={i} className="whitespace-pre-wrap leading-5">
								{l}
							</div>
						))
					)}
					<div ref={logsEndRef} />
				</div>
			)}

			{/* Main content */}
			<div className="flex-1 flex flex-col overflow-hidden">
				{status === "stopped" && (
					<div className="flex-1 flex flex-col items-center justify-center gap-4">
						<div className="text-center space-y-1">
							<p className="text-sm font-medium">{title}</p>
							<p className="text-xs text-muted-foreground">
								Node.js app — will be started on a local port
							</p>
						</div>
						<div className="inline-flex items-stretch overflow-hidden rounded-full bg-primary text-primary-foreground shadow-e-1">
							<button
								type="button"
								onClick={() => handleLaunch()}
								className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-primary-foreground/10 focus-visible:outline-none"
							>
								<Play className="h-4 w-4" />
								Launch app
								{defaultScript && (
									<span className="opacity-70">({defaultScript})</span>
								)}
							</button>
							{altScripts.length > 0 && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="inline-flex items-center justify-center border-l border-l-primary-foreground/20 px-2 transition-colors hover:bg-primary-foreground/10 focus-visible:outline-none"
											aria-label="Choose script to launch"
										>
											<ChevronDown className="h-4 w-4" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuLabel>Run script</DropdownMenuLabel>
										<DropdownMenuSeparator />
										{scripts.map((s) => (
											<DropdownMenuItem
												key={s}
												onSelect={() => handleLaunch(s)}
												className="gap-2 font-mono text-xs"
										>
												<Play className="h-3.5 w-3.5" />
												{s}
												{s === defaultScript && (
													<span className="ml-auto text-[10px] text-muted-foreground">
														default
													</span>
												)}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</div>
				)}

				{isTransient && (
					<div className="flex-1 flex flex-col items-center justify-center gap-3">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
						<p className="text-sm text-muted-foreground">
							{STATUS_LABEL[status]}
						</p>
						{port && (
							<p className="text-xs text-muted-foreground/60">
								port {port}
							</p>
						)}
						<Button onClick={handleStop} variant="outline" size="sm" className="gap-2">
							<Square className="h-3.5 w-3.5" />
							Cancel
						</Button>
					</div>
				)}

				{status === "error" && (
					<div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
						<AlertCircle className="h-8 w-8 text-destructive" />
						<div className="text-center space-y-1 max-w-md">
							<p className="text-sm font-medium text-destructive">
								Failed to start app
							</p>
							<p className="text-xs text-muted-foreground break-words">
								{error ?? "Unknown error"}
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button onClick={handleStop} variant="ghost" className="gap-2">
								Back
							</Button>
							<Button onClick={handleRestart} variant="outline" className="gap-2">
								<RefreshCw className="h-4 w-4" />
								Try again
							</Button>
						</div>
					</div>
				)}

				{status === "running" && (
					<iframe
						key={iframeKey}
						src={proxyUrl}
						className="flex-1 w-full border-0 bg-card"
						title={title}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-top-navigation-by-user-activation"
					/>
				)}
			</div>
		</div>
	);
}
