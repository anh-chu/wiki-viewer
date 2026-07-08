"use client";

import {
	AlertCircle,
	Eye,
	Lock,
	Loader2,
	FileText,
	Copy,
	Check,
	ChevronDown,
	Link,
	Download,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeProvider } from "@/components/theme-provider";
import { KBEditor } from "@/components/editor/editor";
import { useEditorStore } from "@/stores/editor-store";
import { ViewWidthToggle } from "@/components/view-width-toggle";
import { ThemeToggle } from "@/components/theme-toggle";

// ── File type detection ──────────────────────────────────────────────────────

type SharedFileKind = "markdown" | "source" | "text" | "csv" | "image" | "media" | "pdf" | "html" | "binary";

function fileExt(filename: string): string {
	const dot = filename.lastIndexOf(".");
	if (dot < 0) return "";
	return filename.slice(dot + 1).toLowerCase();
}

function sharedFileKind(filename: string): SharedFileKind {
	const e = fileExt(filename);
	if (["md", "markdown"].includes(e)) return "markdown";
	if (["csv", "tsv"].includes(e)) return "csv";
	if (["pdf"].includes(e)) return "pdf";
	if (["html", "htm"].includes(e)) return "html";
	if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"].includes(e)) return "image";
	if (["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac"].includes(e)) return "media";
	if (["txt", "log", "ini", "env", "conf"].includes(e)) return "text";
	if ([
		"py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp", "h",
		"sh", "bash", "zsh", "rb", "php", "swift", "kt", "lua", "sql", "yaml",
		"yml", "toml", "json", "xml", "css", "scss", "mmd", "mermaid",
	].includes(e)) return "source";
	return "binary";
}

// ── State ────────────────────────────────────────────────────────────────────

type ShareState =
	| { kind: "loading" }
	| { kind: "password"; message: string }
	| { kind: "error"; title: string; message: string }
	| { kind: "content"; content: string; filename: string; filePath: string; viewCount: number };

export default function SharedPage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const [token, setToken] = useState<string | null>(null);
	const [state, setState] = useState<ShareState>({ kind: "loading" });
	const [password, setPassword] = useState("");
	const [verifying, setVerifying] = useState(false);
	const [pwdError, setPwdError] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);

	const kind = useMemo(() => {
		if (state.kind !== "content") return "markdown";
		return sharedFileKind(state.filename);
	}, [state]);

	const isMarkdown = kind === "markdown";
	const isTextBased = ["markdown", "source", "text", "csv", "html"].includes(kind);

	const copyShareLink = () => {
		if (!token) return;
		const url = `${window.location.origin}/s/${token}`;
		void navigator.clipboard.writeText(url);
		setCopied("link");
		setTimeout(() => setCopied(null), 2000);
	};

	const copyRawContent = async () => {
		if (state.kind !== "content") return;
		try {
			await navigator.clipboard.writeText(state.content);
			setCopied("raw");
			setTimeout(() => setCopied(null), 2000);
		} catch {
			// silently fail
		}
	};

	const copyFormattedContent = async () => {
		if (state.kind !== "content") return;
		try {
			const { markdownToHtml } = await import("@/lib/markdown/to-html");
			const html = await markdownToHtml(state.content);
			if ("ClipboardItem" in window && navigator.clipboard.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([html], { type: "text/html" }),
						"text/plain": new Blob([state.content], { type: "text/plain" }),
					}),
				]);
			} else {
				await navigator.clipboard.writeText(state.content);
			}
			setCopied("formatted");
			setTimeout(() => setCopied(null), 2000);
		} catch {
			// silently fail
		}
	};

	const handleContentLoaded = useCallback(
		(data: { content: string; filename: string; filePath?: string; viewCount?: number }) => {
			const filename = data.filename ?? "document";
			const fk = sharedFileKind(filename);
			if (fk === "markdown") {
				useEditorStore.setState({
					currentPath: `shared/${token}/${filename}`,
					content: data.content,
					frontmatter: null,
					isLoading: false,
					loadStatus: "ok",
					isDirty: false,
					currentRevision: null,
					saveStatus: "saved",
				});
			}
			setState({
				kind: "content",
				content: data.content,
				filename,
				filePath: data.filePath ?? filename,
				viewCount: data.viewCount ?? 0,
			});
		},
		[token],
	);

	const fetchShare = useCallback(
		async () => {
			if (!token) return;
			setState({ kind: "loading" });
			try {
				const res = await fetch(`/api/share/${token}`);
				const data = await res.json();

				if (res.ok && data.content !== undefined) {
					handleContentLoaded(data);
				} else if (res.status === 401 && data.protected) {
					setState({ kind: "password", message: data.message ?? "" });
				} else if (res.status === 410) {
					setState({
						kind: "error",
						title: "Link unavailable",
						message: data.message ?? "This share link is no longer available.",
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
						message: data.message ?? "Something went wrong. Try again later.",
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
		[token, handleContentLoaded],
	);

	// Resolve token from params
	useEffect(() => {
		void params.then((p) => setToken(p.token));
	}, [params]);

	// Fetch on token resolve (no password)
	useEffect(() => {
		if (token) void fetchShare();
	}, [token, fetchShare]);

	const handleSubmitPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!password.trim() || !token) return;
		setVerifying(true);
		setPwdError(false);
		try {
			const res = await fetch(`/api/share/${token}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password: password.trim() }),
			});
			const data = await res.json();

			if (res.ok && data.content !== undefined) {
				handleContentLoaded(data);
			} else if (res.status === 403) {
				setPwdError(true);
				setState({ kind: "password", message: "Incorrect password" });
			} else if (res.status === 429) {
				setState({ kind: "password", message: "Too many attempts. Try again later." });
			} else {
				setState({ kind: "error", title: "Error", message: data.message ?? "Something went wrong." });
			}
		} catch {
			setState({ kind: "error", title: "Connection error", message: "Could not reach the server." });
		}
		setVerifying(false);
	};

	return (
		<ThemeProvider>
			<div className="min-h-screen flex flex-col bg-background text-foreground">
				<header className="border-b border-border bg-muted/50">
					<div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-2">
						{state.kind === "content" ? (
							<>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="h-2 w-2 rounded-full bg-success shrink-0" />
									<span className="text-sm font-mono truncate" title={state.filename}>
										{state.filename}
									</span>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												size="sm"
												variant="ghost"
												className="h-7 gap-1.5 px-2 text-xs data-[state=open]:bg-transparent"
												title="Copy link, raw content, or formatted content"
											>
												{copied === "link" ? (
													<Check className="h-3.5 w-3.5 text-success" />
												) : (
													<Copy className="h-3.5 w-3.5" />
												)}
												Copy
												<ChevronDown className="h-3 w-3 opacity-60" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="w-48">
											<DropdownMenuItem onClick={copyShareLink}>
												<Link className="mr-2 h-3.5 w-3.5" />
												Copy share link
											</DropdownMenuItem>
											{isTextBased && (
												<>
													<DropdownMenuSeparator />
													<DropdownMenuItem onClick={copyRawContent}>
														<FileText className="mr-2 h-3.5 w-3.5" />
														Copy raw content
													</DropdownMenuItem>
													{isMarkdown && (
														<DropdownMenuItem onClick={copyFormattedContent}>
															<FileText className="mr-2 h-3.5 w-3.5" />
															Copy formatted content
														</DropdownMenuItem>
													)}
												</>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
									{isMarkdown && <ViewWidthToggle />}
									<ThemeToggle />
									<span className="text-xs text-muted-foreground ml-2">
										{state.viewCount} view
										{state.viewCount !== 1 ? "s" : ""}
									</span>
								</div>
							</>
						) : (
							<>
								<Eye className="h-4 w-4 text-muted-foreground" />
								<span className="text-xs font-medium text-muted-foreground">
									Shared document
								</span>
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
									<h1 className="text-base font-medium">
										Password required
									</h1>
									<p className="text-sm text-muted-foreground">
										{state.message ||
											"This document is password-protected."}
									</p>
								</div>
								<form
									onSubmit={handleSubmitPassword}
									className="w-full space-y-3"
								>
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
									<Button
										type="submit"
										className="w-full"
										disabled={verifying || !password.trim()}
									>
										{verifying ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											"View document"
										)}
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
							<p className="text-sm text-muted-foreground">
								{state.message}
							</p>
						</div>
					</div>
				)}

				{state.kind === "content" && (
					<SharedContentViewer
						kind={kind}
						content={state.content}
						filename={state.filename}
						token={token!}
					/>
				)}

				{state.kind === "content" && (
					<footer className="border-t border-border bg-muted/30">
						<div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-2">
							<FileText className="h-3 w-3 text-muted-foreground" />
							<span className="text-xs text-muted-foreground">
								{state.filename}
							</span>
						</div>
					</footer>
				)}
			</div>
		</ThemeProvider>
	);
}

// ── Content viewer by file kind ──────────────────────────────────────────────

function SharedContentViewer({
	kind,
	content,
	filename,
	token,
}: {
	kind: SharedFileKind;
	content: string;
	filename: string;
	token: string;
}) {
	const assetUrl = `/api/share/${token}/asset`;

	switch (kind) {
		case "markdown":
			return <KBEditor mode="viewing" />;

		case "image":
			return (
				<div className="flex-1 flex items-center justify-center p-8 bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={assetUrl}
						alt={filename}
						className="max-w-full max-h-[80vh] object-contain rounded-sm"
					/>
				</div>
			);

		case "pdf":
			return (
				<div className="flex-1 flex flex-col min-h-0">
					<iframe
						src={assetUrl}
						title={filename}
						className="flex-1 w-full border-0"
						style={{ minHeight: "80vh" }}
					/>
				</div>
			);

		case "media": {
			const e = fileExt(filename);
			const isVideo = ["mp4", "webm", "mov", "m4v"].includes(e);
			return (
				<div className="flex-1 flex items-center justify-center p-8">
					{isVideo ? (
						<video controls className="max-w-full max-h-[80vh] rounded-sm" src={assetUrl} />
					) : (
						<div className="w-full max-w-md">
							<audio controls className="w-full" src={assetUrl} />
							<p className="text-center text-sm text-muted-foreground mt-3">{filename}</p>
						</div>
					)}
				</div>
			);
		}

		case "html":
			return (
				<div className="flex-1 flex flex-col min-h-0">
					<iframe
						srcDoc={content}
						title={filename}
						className="flex-1 w-full border-0 bg-white"
						style={{ minHeight: "80vh" }}
						sandbox="allow-scripts allow-same-origin"
					/>
				</div>
			);

		case "csv":
			return <SharedCsvViewer content={content} />;

		case "source":
		case "text":
			return <SharedSourceViewer content={content} filename={filename} />;

		case "binary":
			return (
				<div className="flex-1 flex flex-col items-center justify-center gap-4 p-8">
					<FileText className="h-12 w-12 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">{filename}</p>
					<a href={assetUrl} download={filename}>
						<Button size="sm" variant="outline" className="gap-1.5">
							<Download className="h-3.5 w-3.5" />
							Download file
						</Button>
					</a>
				</div>
			);
	}
}

// ── Source code viewer with line numbers ──────────────────────────────────────

function SharedSourceViewer({ content, filename }: { content: string; filename: string }) {
	const lines = content.split("\n");
	const lineCount = lines.length;
	const [showAll, setShowAll] = useState(lineCount <= 500);
	const visibleLines = showAll ? lines : lines.slice(0, 500);

	return (
		<div className="flex-1 overflow-auto">
			<div className="mx-auto max-w-4xl">
				<div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
					<span className="text-xs text-muted-foreground font-mono">{filename}</span>
					<span className="text-xs text-muted-foreground">{lineCount.toLocaleString()} lines</span>
				</div>
				<pre className="text-[13px] font-mono leading-relaxed">
					<table className="w-full border-collapse">
						<tbody>
							{visibleLines.map((line, i) => (
								<tr key={i} className="hover:bg-muted/50">
									<td className="select-none text-right pr-4 pl-4 py-0 text-muted-foreground/50 text-xs w-[1%] whitespace-nowrap align-top">
										{i + 1}
									</td>
									<td className="pr-4 py-0 whitespace-pre-wrap break-all">
										{line || "\u00a0"}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</pre>
				{!showAll && lineCount > 500 && (
					<div className="flex justify-center py-4 border-t">
						<Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
							Show all {lineCount.toLocaleString()} lines
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

// ── CSV viewer ───────────────────────────────────────────────────────────────

function SharedCsvViewer({ content }: { content: string }) {
	const rows = useMemo(() => {
		return content.split("\n").filter(Boolean).map(row => {
			const cells: string[] = [];
			let current = "";
			let inQuotes = false;
			for (let i = 0; i < row.length; i++) {
				const ch = row[i];
				if (ch === '"') {
					inQuotes = !inQuotes;
				} else if ((ch === "," || ch === "\t") && !inQuotes) {
					cells.push(current.trim());
					current = "";
				} else {
					current += ch;
				}
			}
			cells.push(current.trim());
			return cells;
		});
	}, [content]);

	if (rows.length === 0) return null;
	const header = rows[0];
	const body = rows.slice(1);

	return (
		<div className="flex-1 overflow-auto">
			<div className="mx-auto max-w-6xl p-4">
				<table className="w-full text-sm border-collapse">
					<thead>
						<tr>
							{header.map((cell, i) => (
								<th key={i} className="text-left px-3 py-2 border-b-2 border-border font-medium bg-muted/50 whitespace-nowrap">
									{cell}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((row, i) => (
							<tr key={i} className="hover:bg-muted/30">
								{row.map((cell, j) => (
									<td key={j} className="px-3 py-1.5 border-b border-border/50 whitespace-nowrap">
										{cell}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
