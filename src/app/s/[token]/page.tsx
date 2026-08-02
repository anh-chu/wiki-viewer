"use client";

import { AlertCircle, Eye, Lock, Loader2, FileText, Copy, Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/url-prefix";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ThemeProvider } from "@/components/theme-provider";
import { ViewWidthToggle } from "@/components/view-width-toggle";
import { ThemeToggle } from "@/components/theme-toggle";
import { SharedContentViewer, sharedFileKind } from "@/components/share/shared-content-viewer";

type ShareState =
	| { kind: "loading" }
	| { kind: "password"; message: string }
	| { kind: "error"; title: string; message: string }
	| { kind: "content"; content: string; filename: string; filePath: string; viewCount: number };

export default function SharedPage({ params }: { params: Promise<{ token: string }> }) {
	const [token, setToken] = useState<string | null>(null);
	const [state, setState] = useState<ShareState>({ kind: "loading" });
	const [password, setPassword] = useState("");
	const [verifying, setVerifying] = useState(false);
	const [pwdError, setPwdError] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);

	const kind = state.kind === "content" ? sharedFileKind(state.filename) : "markdown";
	const isTextBased = ["markdown", "source", "text", "csv", "html"].includes(kind);

	const flashCopied = (key: string) => {
		setCopied(key);
		setTimeout(() => setCopied(null), 2000);
	};

	const copyShareLink = () => {
		if (!token) return;
		void navigator.clipboard.writeText(`${window.location.origin}/s/${token}`);
		flashCopied("link");
	};

	const copyRawContent = async () => {
		if (state.kind !== "content") return;
		try {
			await navigator.clipboard.writeText(state.content);
			flashCopied("raw");
		} catch {
			/* ignore */
		}
	};

	const fetchShare = useCallback(async () => {
		if (!token) return;
		setState({ kind: "loading" });
		try {
			const res = await fetch(apiUrl(`/api/share/${token}`));
			const data = (await res.json()) as Record<string, unknown>;

			if (res.ok && typeof data.content === "string") {
				setState({
					kind: "content",
					content: data.content,
					filename: String(data.filename ?? "document"),
					filePath: String(data.filePath ?? data.filename ?? "document"),
					viewCount: typeof data.viewCount === "number" ? data.viewCount : 0,
				});
			} else if (res.status === 401 && data.protected) {
				setState({ kind: "password", message: String(data.message ?? "") });
			} else if (res.status === 410) {
				setState({
					kind: "error",
					title: "Link unavailable",
					message: String(data.message ?? "This share link is no longer available."),
				});
			} else if (res.status === 404) {
				setState({ kind: "error", title: "Not found", message: "This share link does not exist." });
			} else {
				setState({
					kind: "error",
					title: "Error",
					message: String(data.message ?? "Something went wrong. Try again later."),
				});
			}
		} catch {
			setState({ kind: "error", title: "Connection error", message: "Could not reach the server. Check your connection." });
		}
	}, [token]);

	useEffect(() => {
		void params.then((p) => setToken(p.token));
	}, [params]);

	useEffect(() => {
		if (token) void fetchShare();
	}, [token, fetchShare]);

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
			const data = (await res.json()) as Record<string, unknown>;

			if (res.ok && typeof data.content === "string") {
				setState({
					kind: "content",
					content: data.content,
					filename: String(data.filename ?? "document"),
					filePath: String(data.filePath ?? data.filename ?? "document"),
					viewCount: typeof data.viewCount === "number" ? data.viewCount : 0,
				});
			} else if (res.status === 403) {
				setPwdError(true);
				setState({ kind: "password", message: "Incorrect password" });
			} else if (res.status === 429) {
				setState({ kind: "password", message: "Too many attempts. Try again later." });
			} else {
				setState({ kind: "error", title: "Error", message: String(data.message ?? "Something went wrong.") });
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
									{isTextBased && (
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
									{kind === "markdown" && <ViewWidthToggle />}
									<ThemeToggle />
									<span className="text-xs text-muted-foreground ml-2">
										{state.viewCount} view{state.viewCount !== 1 ? "s" : ""}
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

				{state.kind === "content" && (
					<SharedContentViewer
						content={state.content}
						filename={state.filename}
						filePath={state.filePath}
						token={token!}
					/>
				)}

				{state.kind === "content" && (
					<footer className="border-t border-border bg-muted/30">
						<div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-2">
							<FileText className="h-3 w-3 text-muted-foreground" />
							<span className="text-xs text-muted-foreground">{state.filename}</span>
						</div>
					</footer>
				)}
			</div>
		</ThemeProvider>
	);
}
