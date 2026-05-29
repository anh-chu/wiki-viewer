"use client";

import {
	ChevronRight,
	Folder,
	FolderOpen,
	Home,
	Keyboard,
	Loader2,
	HardDrive,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Entry {
	name: string;
	path: string;
	accessible: boolean;
}

interface BrowseResult {
	path: string;
	parent: string | null;
	entries: Entry[];
	shortcuts: Array<{ label: string; path: string }>;
}

interface Props {
	onSelect: (path: string) => void;
}

export function DirPicker({ onSelect }: Props) {
	const [data, setData] = useState<BrowseResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [manualPath, setManualPath] = useState("");
	const [manualMode, setManualMode] = useState(false);
	const [selecting, setSelecting] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const navigate = useCallback(async (dir: string) => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(
				`/api/system/browse?path=${encodeURIComponent(dir)}`,
			);
			if (!res.ok) {
				const e: { error?: string } = await res.json();
				setError(e.error ?? "Cannot open directory");
				return;
			}
			const result: BrowseResult = await res.json();
			setData(result);
			setManualPath(result.path);
		} catch {
			setError("Network error");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		navigate("");
	}, [navigate]);

	const handleSelect = async (dir?: string) => {
		const target = dir ?? data?.path;
		if (!target) return;
		setSelecting(true);
		try {
			const res = await fetch("/api/system/set-root", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: target }),
			});
			if (!res.ok) {
				const e: { error?: string } = await res.json();
				setError(e.error ?? "Cannot use that directory");
				return;
			}
			onSelect(target);
		} catch {
			setError("Network error");
		} finally {
			setSelecting(false);
		}
	};

	const handleManualSubmit = () => {
		if (manualMode) {
			if (manualPath.trim()) navigate(manualPath.trim());
		} else {
			setManualMode(true);
			setTimeout(() => inputRef.current?.select(), 50);
		}
	};

	// Build breadcrumb segments from path
	const breadcrumbs = (data?.path ?? "")
		.split(/[/\\]/)
		.filter(Boolean)
		.reduce<Array<{ label: string; path: string }>>(
			(acc, seg) => {
				const prev = acc[acc.length - 1]?.path ?? "/";
				acc.push({ label: seg, path: `${prev === "/" ? "" : prev}/${seg}` });
				return acc;
			},
			[{ label: "/", path: "/" }],
		);

	return (
		<div className="flex flex-1 items-center justify-center bg-background p-4">
			<div className="flex w-full max-w-xl flex-col gap-4">
				{/* Header */}
				<div className="text-center space-y-1">
					<h1 className="text-xl font-medium">Choose a directory</h1>
					<p className="text-sm text-muted-foreground">
						Select the folder wiki-viewer should serve.
						<br />
						This directory lives on the server — use the browser below.
					</p>
				</div>

				{/* Main browser card */}
				<div className="rounded-lg border bg-card shadow-sm overflow-hidden">
					{/* Breadcrumb bar */}
					<div className="flex items-center gap-1 border-b px-3 py-2 bg-muted overflow-x-auto shrink-0 min-h-[40px]">
						{manualMode ? (
							<input
								ref={inputRef}
								className="flex-1 bg-transparent text-sm outline-none font-mono"
								value={manualPath}
								onChange={(e) => setManualPath(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										navigate(manualPath.trim());
										setManualMode(false);
									}
									if (e.key === "Escape") {
										setManualPath(data?.path ?? "");
										setManualMode(false);
									}
								}}
								onBlur={() => {
									setManualPath(data?.path ?? "");
									setManualMode(false);
								}}
								spellCheck={false}
							/>
						) : (
							<>
								{breadcrumbs.map((seg, i) => (
									<span key={seg.path} className="flex items-center gap-1 shrink-0">
										{i > 0 && (
											<ChevronRight className="h-3 w-3 text-muted-foreground/50" />
										)}
										<button
											type="button"
											className="text-xs hover:text-foreground text-muted-foreground transition-colors rounded px-0.5"
											onClick={() => navigate(seg.path)}
										>
											{i === 0 ? (
												<HardDrive className="h-3.5 w-3.5" />
											) : (
												seg.label
											)}
										</button>
									</span>
								))}
							</>
						)}
						<button
							type="button"
							className="ml-auto shrink-0 p-1 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
							title="Type a path"
							onClick={handleManualSubmit}
						>
							<Keyboard className="h-3.5 w-3.5" />
						</button>
					</div>

					{/* Directory list */}
					<div className="max-h-72 overflow-y-auto">
						{loading ? (
							<div className="flex justify-center py-8">
								<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
							</div>
						) : error ? (
							<div className="px-4 py-3 text-sm text-destructive">{error}</div>
						) : (
							<>
								{/* Parent directory */}
								{data?.parent && (
									<button
										type="button"
										className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
										onClick={() => navigate(data.parent!)}
									>
										<Folder className="h-4 w-4 shrink-0" />
										<span className="font-mono text-xs">..</span>
									</button>
								)}

								{data?.entries.length === 0 && (
									<p className="px-4 py-3 text-sm text-muted-foreground/60">
										No subdirectories
									</p>
								)}

								{data?.entries.map((entry) => (
									<button
										type="button"
										key={entry.path}
										className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
										onClick={() => navigate(entry.path)}
									>
										<Folder className="h-4 w-4 shrink-0 text-warning" />
										<span className="truncate">{entry.name}</span>
									</button>
								))}
							</>
						)}
					</div>

					{/* Select button */}
					<div className="border-t px-3 py-2 flex items-center justify-between gap-2 bg-muted">
						<span
							className="text-xs text-muted-foreground truncate font-mono"
							title={data?.path}
						>
							{data?.path ?? "—"}
						</span>
						<Button
							size="sm"
							className="shrink-0 gap-1.5"
							disabled={!data || selecting}
							onClick={() => handleSelect()}
						>
							{selecting ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<FolderOpen className="h-3.5 w-3.5" />
							)}
							Select
						</Button>
					</div>
				</div>

				{/* Shortcuts */}
				{data?.shortcuts && data.shortcuts.length > 0 && (
					<div className="flex flex-wrap gap-1.5 justify-center">
						{data.shortcuts.map((s) => (
							<Button
								key={s.path}
								variant="outline"
								size="sm"
								className="h-7 gap-1.5 text-xs"
								onClick={() => navigate(s.path)}
							>
								{s.label === "Home" ? (
									<Home className="h-3 w-3" />
								) : (
									<HardDrive className="h-3 w-3" />
								)}
								{s.label}
							</Button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
