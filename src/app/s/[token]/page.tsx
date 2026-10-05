"use client";

import {
	AlertCircle,
	ArrowLeft,
	Check,
	ChevronRight,
	Copy,
	Eye,
	FileText,
	Folder,
	Loader2,
	Lock,
	PanelLeft,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiUrl } from "@/lib/url-prefix";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ThemeProvider } from "@/components/theme-provider";
import { ViewWidthToggle } from "@/components/view-width-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { SharedContentViewer, sharedFileKind } from "@/components/share/shared-content-viewer";
import { ShareTree, type ShareEntry } from "@/components/share/share-tree";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
	useViewWidthStore,
	VIEW_ALIGN_CLASS,
	VIEW_WIDTH_CLASS,
} from "@/stores/view-width-store";


type ShareState =
	| { kind: "loading" }
	| { kind: "password"; message: string }
	| { kind: "error"; title: string; message: string }
	| {
			kind: "file";
			content: string;
			filename: string;
			filePath: string;
			relPath: string;
			viewCount: number;
	  }
	| {
			kind: "dir";
			name: string;
			path: string;
			entries: ShareEntry[];
			truncated: boolean;
			viewCount: number;
	  };

/**
 * Kinds rendered from their raw bytes through the asset route. A file of one of
 * these kinds still opens when the content request fails, which happens for a
 * file larger than the display cap.
 */
const ASSET_KINDS = new Set(["image", "pdf", "media", "binary"]);

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parentOf(rel: string): string {
	const slash = rel.lastIndexOf("/");
	return slash === -1 ? "" : rel.slice(0, slash);
}

export default function SharedPage({ params }: { params: Promise<{ token: string }> }) {
	const [token, setToken] = useState<string | null>(null);
	const [relPath, setRelPath] = useState("");
	const [state, setState] = useState<ShareState>({ kind: "loading" });
	const [password, setPassword] = useState("");
	const [verifying, setVerifying] = useState(false);
	const [pwdError, setPwdError] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	/** What the share itself is, as opposed to what this view shows. */
	const [shareKind, setShareKind] = useState<"file" | "dir" | null>(null);
	const [shareName, setShareName] = useState("");
	/** null until the stored preference is read, then the visitor's choice. */
	const [navOpen, setNavOpen] = useState<boolean | null>(null);
	const isMobile = useIsMobile();
	const viewWidth = useViewWidthStore((s) => s.width);
	const viewAlign = useViewWidthStore((s) => s.align);

	const fileKind = state.kind === "file" ? sharedFileKind(state.filename) : "markdown";
	const isTextBased = ["markdown", "source", "text", "csv", "html"].includes(fileKind);
	/** Reader preferences: the same stored values the app's own toolbar uses. */
	const readerClass = cn(VIEW_ALIGN_CLASS[viewAlign], VIEW_WIDTH_CLASS[viewWidth]);
	/**
	 * Tailwind Typography sets an absolute font-size on `.prose`, so the chosen
	 * body size and font go on that element as an inline style, which wins.
	 */
	const readerStyle: CSSProperties = {
		fontFamily: "var(--font-family-body)",
		fontSize: "calc(1rem * var(--font-scale-body, 1))",
	};

	const flashCopied = (key: string) => {
		setCopied(key);
		setTimeout(() => setCopied(null), 2000);
	};

	// Copy the current view URL: for a file inside a shared folder that is the
	// link to that file, not just to the share root.
	const copyShareLink = () => {
		void navigator.clipboard.writeText(window.location.href);
		flashCopied("link");
	};

	const copyRawContent = async () => {
		if (state.kind !== "file") return;
		try {
			await navigator.clipboard.writeText(state.content);
			flashCopied("raw");
		} catch {
			/* ignore */
		}
	};

	const applyView = (data: Record<string, unknown>, requested: string): ShareState | null => {
		if (data.shareKind === "file" || data.shareKind === "dir") {
			setShareKind(data.shareKind);
		}
		if (typeof data.shareName === "string" && data.shareName) setShareName(data.shareName);
		const viewCount = typeof data.viewCount === "number" ? data.viewCount : 0;

		if (data.kind === "dir") {
			return {
				kind: "dir",
				name: String(data.name ?? ""),
				path: String(data.path ?? requested),
				entries: Array.isArray(data.entries) ? (data.entries as ShareEntry[]) : [],
				truncated: data.truncated === true,
				viewCount,
			};
		}

		if (typeof data.content === "string") {
			return {
				kind: "file",
				content: data.content,
				filename: String(data.filename ?? "document"),
				filePath: String(data.filePath ?? "document"),
				relPath: String(data.path ?? requested),
				viewCount,
			};
		}

		return null;
	};

	const load = useCallback(
		async (target: string) => {
			if (!token) return;
			setState({ kind: "loading" });
			try {
				const query = target ? `?path=${encodeURIComponent(target)}` : "";
				const res = await fetch(apiUrl(`/api/share/${token}${query}`));
				const data = (await res.json()) as Record<string, unknown>;

				const view = res.ok ? applyView(data, target) : null;
				if (view) {
					setState(view);
					return;
				}

				// A bytes-rendered file needs no content, so an oversized one still
				// opens through the asset route instead of showing a read error.
				const name = target.split("/").pop() ?? "";
				if (target && ASSET_KINDS.has(sharedFileKind(name))) {
					setState({
						kind: "file",
						content: "",
						filename: name,
						filePath: target,
						relPath: target,
						viewCount: 0,
					});
					return;
				}

				if (res.status === 401 && data.protected) {
					setState({ kind: "password", message: String(data.message ?? "") });
				} else if (res.status === 410) {
					setState({
						kind: "error",
						title: "Link unavailable",
						message: String(data.message ?? "This share link is no longer available."),
					});
				} else if (res.status === 404) {
					setState({
						kind: "error",
						title: "Not found",
						message: "This share link does not exist.",
					});
				} else {
					setState({
						kind: "error",
						title: "Error",
						message: String(data.message ?? "Something went wrong. Try again later."),
					});
				}
			} catch {
				setState({
					kind: "error",
					title: "Connection error",
					message: "Could not reach the server. Check your connection.",
				});
			}
		},
		[token],
	);

	useEffect(() => {
		void params.then((p) => {
			setToken(p.token);
			setRelPath(new URLSearchParams(window.location.search).get("path") ?? "");
		});
	}, [params]);

	useEffect(() => {
		if (token) void load(relPath);
	}, [token, relPath, load]);

	/**
	 * Move to a path inside the share and keep it in the URL, so it is copyable
	 * and Back returns to the previous view instead of leaving the share.
	 */
	const navigate = useCallback((target: string) => {
		const url = new URL(window.location.href);
		if (target) url.searchParams.set("path", target);
		else url.searchParams.delete("path");
		window.history.pushState(null, "", url.toString());
		setRelPath(target);
	}, []);

	useEffect(() => {
		const onPopState = () =>
			setRelPath(new URLSearchParams(window.location.search).get("path") ?? "");
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	const showNav = navOpen ?? !isMobile;

	const toggleNav = () => {
		const next = !showNav;
		setNavOpen(next);
		try {
			window.localStorage.setItem("wiki-share-nav", next ? "open" : "closed");
		} catch {
			/* private mode: keep the in-memory choice */
		}
	};

	useEffect(() => {
		try {
			const saved = window.localStorage.getItem("wiki-share-nav");
			if (saved === "open" || saved === "closed") setNavOpen(saved === "open");
		} catch {
			/* private mode */
		}
	}, []);

	// The listing the reader already has, so the tree does not fetch it again
	// (which would also count as a second view of the share).
	const treeSeed = useMemo(
		() =>
			state.kind === "dir" ? { path: state.path, entries: state.entries } : undefined,
		[state],
	);

	const handleSubmitPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!password.trim() || !token) return;
		setVerifying(true);
		setPwdError(false);
		try {
			const res = await fetch(apiUrl(`/api/share/${token}`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: password.trim() }),
			});

			if (res.ok) {
				// The unlock cookie now covers the whole share, so reload the
				// requested view through the normal path.
				setPassword("");
				await load(relPath);
			} else if (res.status === 403) {
				setPwdError(true);
				setState({ kind: "password", message: "Incorrect password" });
			} else if (res.status === 429) {
				setState({ kind: "password", message: "Too many attempts. Try again later." });
			} else {
				const data = (await res.json()) as Record<string, unknown>;
				setState({
					kind: "error",
					title: "Error",
					message: String(data.message ?? "Something went wrong."),
				});
			}
		} catch {
			setState({ kind: "error", title: "Connection error", message: "Could not reach the server." });
		}
		setVerifying(false);
	};

	const showTitle = state.kind === "file" || state.kind === "dir";
	const title =
		state.kind === "file"
			? state.filename
			: state.kind === "dir"
				? state.name || "Shared folder"
				: "";
	// Keep navigation mounted while a view loads: unmounting it on the loading
	// state would drop the tree's cache and refetch every folder on each step,
	// and each root refetch counts as another view of the share.
	const navVisible = shareKind === "dir";
	const navTree = token && navVisible ? (
		<ShareTree
			token={token}
			rootName={shareName || "Shared folder"}
			currentPath={
				state.kind === "file"
					? state.relPath
					: state.kind === "dir"
						? state.path
						: ""
			}
			currentIsDir={state.kind === "dir"}
			seed={treeSeed}
			onNavigate={navigate}
		/>
	) : null;

	return (
		<ThemeProvider>
			<div className="flex min-h-screen bg-background text-foreground">
				{navTree && !isMobile && showNav && (
					<nav
						aria-label="Shared folder"
						className="hidden w-64 shrink-0 border-r border-border bg-muted/20 md:flex md:flex-col"
					>
						<div className="flex-1 overflow-auto p-2">{navTree}</div>
					</nav>
				)}
				{navTree && isMobile && showNav && (
					<div className="fixed inset-0 z-40 flex md:hidden">
						<div className="flex w-72 max-w-[85%] flex-col border-r border-border bg-background">
							<div className="flex-1 overflow-auto p-2">{navTree}</div>
						</div>
						<button
							type="button"
							aria-label="Close navigation"
							className="flex-1 bg-black/40"
							onClick={toggleNav}
						/>
					</div>
				)}
				<div className="flex min-w-0 flex-1 flex-col">
				<header className="border-b border-border bg-muted/50">
					<div className="flex w-full items-center gap-2 px-4 py-2">
						{navVisible && (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 w-7 shrink-0 p-0"
								title={showNav ? "Hide navigation" : "Show navigation"}
								onClick={toggleNav}
							>
								<PanelLeft className="h-3.5 w-3.5" />
							</Button>
						)}
						{showTitle ? (
							<>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="h-2 w-2 rounded-full bg-success shrink-0" />
									{state.kind === "dir" && (
										<Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									)}
									<span className="text-sm truncate" title={title}>
										{title}
									</span>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<Button
										size="sm"
										variant="ghost"
										className="h-7 gap-1.5 px-2 text-xs"
										onClick={copyShareLink}
										title="Copy share link"
									>
										{copied === "link" ? (
											<Check className="h-3.5 w-3.5 text-success" />
										) : (
											<Copy className="h-3.5 w-3.5" />
										)}
										Link
									</Button>
									{state.kind === "file" && isTextBased && (
										<Button
											size="sm"
											variant="ghost"
											className="h-7 gap-1.5 px-2 text-xs"
											onClick={copyRawContent}
											title="Copy raw content"
										>
											{copied === "raw" ? (
												<Check className="h-3.5 w-3.5 text-success" />
											) : (
												<FileText className="h-3.5 w-3.5" />
											)}
											Raw
										</Button>
									)}
									{(state.kind === "dir" ||
										(state.kind === "file" &&
											["markdown", "source", "text", "csv"].includes(fileKind))) && (
										<ViewWidthToggle />
									)}
									<ThemeToggle />
									<span className="text-xs text-muted-foreground ml-2">
										{state.kind === "file" || state.kind === "dir"
											? `${state.viewCount} view${state.viewCount !== 1 ? "s" : ""}`
											: ""}
									</span>
								</div>
							</>
						) : (
							<>
								<Eye className="h-4 w-4 text-muted-foreground" />
								<span className="text-xs font-medium text-muted-foreground">Shared document</span>
							</>
						)}
					</div>
				</header>

				{state.kind === "loading" && (
					<div className="flex-1 flex items-center justify-center">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				)}

				{state.kind === "password" && (
					<div className="flex-1 flex items-center justify-center px-4">
						<Card className="max-w-sm w-full p-6">
							<div className="flex flex-col items-center gap-4 text-center">
								<div className="rounded-full bg-muted p-3">
									<Lock className="h-6 w-6 text-muted-foreground" />
								</div>
								<div className="space-y-1">
									<h1 className="text-base font-medium">Password required</h1>
									<p className="text-sm text-muted-foreground">
										{state.message || "This document is password-protected."}
									</p>
								</div>
								<form onSubmit={handleSubmitPassword} className="w-full space-y-3">
									<Input
										type="password"
										placeholder="Enter password"
										value={password}
										onChange={(e) => {
											setPassword(e.target.value);
											setPwdError(false);
										}}
										autoFocus
									/>
									{pwdError && (
										<p className="text-xs text-destructive flex items-center gap-1">
											<AlertCircle className="h-3 w-3" />
											Wrong password. Try again.
										</p>
									)}
									<Button type="submit" className="w-full" disabled={verifying || !password.trim()}>
										{verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : "View document"}
									</Button>
								</form>
							</div>
						</Card>
					</div>
				)}

				{state.kind === "error" && (
					<div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 text-center">
						<div className="rounded-full bg-muted p-3">
							<AlertCircle className="h-6 w-6 text-muted-foreground" />
						</div>
						<div className="space-y-1">
							<h1 className="text-base font-medium">{state.title}</h1>
							<p className="text-sm text-muted-foreground">{state.message}</p>
						</div>
					</div>
				)}

				{state.kind === "dir" && (
					<div className="flex-1 overflow-auto">
					<div className={cn("w-full px-4 py-6", readerClass)}>
							<nav
								className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
								aria-label="Breadcrumb"
							>
								<button
									type="button"
									className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
									onClick={() => navigate("")}
								>
									{state.name || "Shared folder"}
								</button>
								{state.path
									.split("/")
									.filter(Boolean)
									.map((segment, i, parts) => {
										const target = parts.slice(0, i + 1).join("/");
										return (
											<span key={target} className="flex items-center gap-1">
												<ChevronRight className="h-3 w-3" />
												<button
													type="button"
													className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
													onClick={() => navigate(target)}
												>
													{segment}
												</button>
											</span>
										);
									})}
							</nav>

							<ul className="divide-y overflow-hidden rounded-md border border-border">
								{state.path !== "" && (
									<li>
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
											onClick={() => navigate(parentOf(state.path))}
										>
											<ArrowLeft className="h-3.5 w-3.5 text-muted-foreground" />
											<span className="text-sm text-muted-foreground">Parent folder</span>
										</button>
									</li>
								)}
								{state.entries.map((entry) => (
									<li key={entry.path}>
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
											onClick={() => navigate(entry.path)}
										>
											{entry.isDir ? (
												<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
											) : (
												<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
											)}
											<span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
											{!entry.isDir && (
												<span className="shrink-0 text-xs text-muted-foreground">
													{formatSize(entry.size)}
												</span>
											)}
										</button>
									</li>
								))}
								{state.entries.length === 0 && (
									<li className="px-3 py-8 text-center text-sm text-muted-foreground">
										This folder is empty.
									</li>
								)}
							</ul>

							{state.truncated && (
								<p className="mt-2 text-xs text-muted-foreground">
									Showing the first 2000 entries.
								</p>
							)}
						</div>
					</div>
				)}

				{state.kind === "file" && (
					<SharedContentViewer
						content={state.content}
						filename={state.filename}
						filePath={state.filePath}
						token={token!}
						relPath={state.relPath}
						readerClass={readerClass}
						readerStyle={readerStyle}
						onNavigate={navigate}
					/>
				)}

				{state.kind === "file" && (
					<footer className="border-t border-border bg-muted/30">
						<div className={cn("flex w-full items-center gap-2 px-4 py-2", readerClass)}>
							<FileText className="h-3 w-3 text-muted-foreground" />
							<span className="text-xs text-muted-foreground">{state.filename}</span>
						</div>
					</footer>
				)}
				</div>
			</div>
		</ThemeProvider>
	);
}
