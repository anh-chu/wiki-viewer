"use client";

import {
	ChevronRight,
	Folder,
	FolderOpen,
	HardDrive,
	Home,
	Loader2,
	Pin,
	PinOff,
	X,
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
	const [pathInput, setPathInput] = useState("");
	const [selecting, setSelecting] = useState(false);
	const [pins, setPins] = useState<string[]>([]);
	const [pinLoading, setPinLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const navigate = useCallback(async (dir: string, updateInput = true) => {
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
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
			if (updateInput) setPathInput(result.path);
		} catch {
			setError("Network error");
		} finally {
			setLoading(false);
		}
	}, []);

	// On mount: load config (last opened + pins), then navigate
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/system/config");
				if (res.ok && !cancelled) {
					const cfg: { pinnedPaths: string[]; lastOpenedPath: string | null } =
						await res.json();
					setPins(cfg.pinnedPaths ?? []);
					await navigate(cfg.lastOpenedPath ?? "");
					return;
				}
			} catch {
				/* fallthrough to default */
			}
			if (!cancelled) await navigate("");
		})();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

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

	const handlePathKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			navigate(pathInput.trim());
		}
		if (e.key === "Escape") {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			setPathInput(data?.path ?? "");
			inputRef.current?.blur();
		}
	};

	const isPinned = data ? pins.includes(data.path) : false;

	const togglePin = async () => {
		if (!data) return;
		setPinLoading(true);
		try {
			const action = isPinned ? "unpin" : "pin";
			const res = await fetch("/api/system/pins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: data.path, action }),
			});
			if (res.ok) {
				setPins((prev) =>
					action === "pin"
						? [...prev, data.path]
						: prev.filter((p) => p !== data.path),
				);
			}
		} catch {
			/* ignore */
		} finally {
			setPinLoading(false);
		}
	};

	const removePin = async (p: string) => {
		try {
			const res = await fetch("/api/system/pins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: p, action: "unpin" }),
			});
			if (res.ok) setPins((prev) => prev.filter((x) => x !== p));
		} catch {
			/* ignore */
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
					{/* Path input bar — always visible, reactive with browser */}
					<div className="flex items-center gap-2 border-b px-3 py-2 bg-muted">
						<input
							ref={inputRef}
							className="flex-1 bg-transparent text-sm outline-none font-mono min-w-0"
							value={pathInput}
							onChange={(e) => {
								const val = e.target.value;
								setPathInput(val);
								if (debounceRef.current) clearTimeout(debounceRef.current);
								debounceRef.current = setTimeout(() => {
									debounceRef.current = null;
									navigate(val.trim(), false);
								}, 500);
							}}
							onKeyDown={handlePathKeyDown}
							spellCheck={false}
							placeholder="Enter a path…"
						/>

					</div>

					{/* Breadcrumb bar (click to navigate) */}
					<div className="flex items-center gap-1 border-b px-3 py-1.5 bg-muted/50 overflow-x-auto shrink-0 min-h-[32px]">
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
					</div>

					{/* Directory list */}
					<div className="max-h-60 overflow-y-auto">
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

					{/* Select footer */}
					<div className="border-t px-3 py-2 flex items-center justify-between gap-2 bg-muted">
						<button
							type="button"
							className={cn(
								"flex items-center gap-1.5 text-xs transition-colors rounded px-1.5 py-1",
								isPinned
									? "text-foreground hover:text-destructive"
									: "text-muted-foreground hover:text-foreground",
							)}
							title={isPinned ? "Unpin this path" : "Pin this path for quick access"}
							onClick={togglePin}
							disabled={pinLoading || !data}
						>
							{pinLoading ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : isPinned ? (
								<PinOff className="h-3.5 w-3.5" />
							) : (
								<Pin className="h-3.5 w-3.5" />
							)}
							{isPinned ? "Unpin" : "Pin"}
						</button>
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

				{/* Pinned paths */}
				{pins.length > 0 && (
					<div className="rounded-lg border bg-card shadow-sm overflow-hidden">
						<div className="px-3 py-2 border-b bg-muted">
							<span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
								<Pin className="h-3 w-3" /> Pinned
							</span>
						</div>
						<div className="max-h-40 overflow-y-auto">
							{pins.map((p) => (
								<div
									key={p}
									className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent group"
								>
									<button
										type="button"
										className="flex-1 flex items-center gap-2 text-sm text-left min-w-0"
										onClick={() => navigate(p)}
									>
										<Folder className="h-4 w-4 shrink-0 text-warning" />
										<span className="truncate font-mono text-xs">{p}</span>
									</button>
									<button
										type="button"
										className="shrink-0 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all"
										onClick={() => removePin(p)}
										title="Remove pin"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								</div>
							))}
						</div>
					</div>
				)}

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
