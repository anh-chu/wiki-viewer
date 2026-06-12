"use client";

import {
	ChevronRight,
	Folder,
	FolderOpen,
	GitBranch,
	HardDrive,
	Home,
	Key,
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
	/** Called with the new workspace id after creation */
	onSelect: (workspaceId: string) => void;
}

export function DirPicker({ onSelect }: Props) {
	const [mode, setMode] = useState<"local" | "git">("local");

	// Local folder state
	const [data, setData] = useState<BrowseResult | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pathInput, setPathInput] = useState("");
	const [selecting, setSelecting] = useState(false);
	const [pins, setPins] = useState<string[]>([]);
	const [pinLoading, setPinLoading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// From Git state
	const [gitRemoteUrl, setGitRemoteUrl] = useState("");
	const [gitBranch, setGitBranch] = useState("");
	const [gitSubpath, setGitSubpath] = useState("");
	const [gitUsername, setGitUsername] = useState("");
	const [gitToken, setGitToken] = useState("");
	const [gitName, setGitName] = useState("");
	const [gitSubmitting, setGitSubmitting] = useState(false);
	const [gitError, setGitError] = useState<string | null>(null);

	const handleGitSubmit = async () => {
		const remoteUrl = gitRemoteUrl.trim();
		if (!remoteUrl) {
			setGitError("Repository URL is required.");
			return;
		}
		setGitSubmitting(true);
		setGitError(null);
		try {
			const body: Record<string, string> = { remoteUrl };
			if (gitBranch.trim()) body.branch = gitBranch.trim();
			if (gitSubpath.trim()) body.subpath = gitSubpath.trim();
			if (gitUsername.trim()) body.username = gitUsername.trim();
			if (gitToken.trim()) body.token = gitToken.trim();
			if (gitName.trim()) body.name = gitName.trim();
			const res = await fetch("/api/system/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const e: { error?: string; message?: string } = await res.json();
				setGitError(e.error ?? e.message ?? "Clone failed.");
				return;
			}
			const { workspace }: { workspace: { id: string } } = await res.json();
			// Drop the token from memory as soon as the clone succeeds.
			setGitToken("");
			onSelect(workspace.id);
		} catch {
			setGitError("Network error.");
		} finally {
			setGitSubmitting(false);
		}
	};

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
			const res = await fetch("/api/system/workspaces", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rootDir: target }),
			});
			if (!res.ok) {
				const e: { error?: string; message?: string } = await res.json();
				setError(e.message ?? e.error ?? "Cannot use that directory");
				return;
			}
			const { workspace }: { workspace: { id: string } } = await res.json();
			onSelect(workspace.id);
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
					<div className="flex items-center justify-center gap-2 mb-1">
						<img src="/logo.svg" alt="Wiki Viewer" className="h-8 w-8" />
						<span className="text-xl font-semibold tracking-tight">Wiki Viewer</span>
					</div>
					<h1 className="text-xl font-medium">
						{mode === "git" ? "Add a Git repository" : "Choose a directory"}
					</h1>
					<p className="text-sm text-muted-foreground">
						{mode === "git" ? (
							<>
								Clone a remote repo and serve it as a read-only workspace.
								<br />
								The server clones it, so the URL must be reachable from the server.
							</>
						) : (
							<>
								Select the folder wiki-viewer should serve.
								<br />
								This directory lives on the server, so use the browser below.
							</>
						)}
					</p>
				</div>

				{/* Mode toggle */}
				<div className="flex items-center self-center rounded-lg border bg-muted p-0.5 gap-0.5">
					<Button
						variant={mode === "local" ? "default" : "ghost"}
						size="sm"
						className="h-7 px-3 text-xs gap-1.5"
						onClick={() => { setMode("local"); setGitToken(""); setGitError(null); }}
					>
						<Folder className="h-3.5 w-3.5" />
						Local folder
					</Button>
					<Button
						variant={mode === "git" ? "default" : "ghost"}
						size="sm"
						className="h-7 px-3 text-xs gap-1.5"
						onClick={() => setMode("git")}
					>
						<GitBranch className="h-3.5 w-3.5" />
						From Git
					</Button>
				</div>

				{/* From Git form */}
				{mode === "git" && (
					<div className="rounded-lg border bg-card shadow-sm overflow-hidden">
						<div className="px-4 pt-4 pb-3 flex flex-col gap-3">
							{/* Remote URL */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Repository URL</label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<input
										className="flex-1 bg-transparent text-sm outline-none font-mono min-w-0"
										placeholder="https://github.com/org/repo.git"
										value={gitRemoteUrl}
										onChange={(e) => { setGitRemoteUrl(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
										autoComplete="off"
										spellCheck={false}
									/>
								</div>
								<p className="text-[11px] text-muted-foreground">Only https:// URLs are supported.</p>
							</div>

							{/* Branch */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Branch <span className="font-normal text-muted-foreground">(optional)</span></label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<input
										className="flex-1 bg-transparent text-sm outline-none min-w-0"
										placeholder="main (default branch if empty)"
										value={gitBranch}
										onChange={(e) => { setGitBranch(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
									/>
								</div>
							</div>

							{/* Subpath */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Subdirectory <span className="font-normal text-muted-foreground">(optional)</span></label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<input
										className="flex-1 bg-transparent text-sm outline-none font-mono min-w-0"
										placeholder="docs (whole repo if empty)"
										value={gitSubpath}
										onChange={(e) => { setGitSubpath(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
										spellCheck={false}
									/>
								</div>
								<p className="text-[11px] text-muted-foreground">Serve only this folder from the repo. Faster to clone for large repos with docs in a subfolder.</p>
							</div>

							{/* Username */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Username <span className="font-normal text-muted-foreground">(optional)</span></label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<input
										className="flex-1 bg-transparent text-sm outline-none min-w-0"
										placeholder="x-access-token (default)"
										value={gitUsername}
										onChange={(e) => { setGitUsername(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
										autoComplete="off"
									/>
								</div>
								<p className="text-[11px] text-muted-foreground">GitLab uses <code className="font-mono">oauth2</code>; Bitbucket uses your account username.</p>
							</div>

							{/* Token */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Access token <span className="font-normal text-muted-foreground">(optional)</span></label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<Key className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									<input
										type="password"
										className="flex-1 bg-transparent text-sm outline-none min-w-0"
										placeholder="Personal access token"
										value={gitToken}
										onChange={(e) => { setGitToken(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
										autoComplete="off"
									/>
								</div>
								<p className="text-[11px] text-muted-foreground">Required only for private repos. Stored securely on the server and never shown again.</p>
							</div>

							{/* Display name */}
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium">Display name <span className="font-normal text-muted-foreground">(optional)</span></label>
								<div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
									<input
										className="flex-1 bg-transparent text-sm outline-none min-w-0"
										placeholder="Defaults to the repository name"
										value={gitName}
										onChange={(e) => { setGitName(e.target.value); setGitError(null); }}
										disabled={gitSubmitting}
									/>
								</div>
							</div>

							{/* Error */}
							{gitError && (
								<p className="text-sm text-destructive">{gitError}</p>
							)}
						</div>

						{/* Footer */}
						<div className="border-t px-4 py-3 flex items-center justify-between gap-3 bg-muted">
							<p className="text-[11px] text-muted-foreground">
								Git workspaces are read-only, so editing is disabled.
							</p>
							<Button
								size="sm"
								className="shrink-0 gap-1.5"
								disabled={gitSubmitting}
								onClick={handleGitSubmit}
							>
								{gitSubmitting ? (
									<><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cloning...</>
								) : (
									<><GitBranch className="h-3.5 w-3.5" /> Clone and add</>
								)}
							</Button>
						</div>
					</div>
				)}

				{/* Main browser card */}
				{mode === "local" && <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
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
				</div>}

				{/* Pinned paths */}
				{mode === "local" && pins.length > 0 && (
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
				{mode === "local" && data?.shortcuts && data.shortcuts.length > 0 && (
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
