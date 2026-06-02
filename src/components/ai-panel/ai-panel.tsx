"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { X, Copy, Check, Bot, Wifi, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { TokenSection } from "./token-section";
import { ActivityRow } from "./activity-row";
import { authClient } from "@/lib/auth/client";
const SKILL_CLI = "npx skills add anh-chu/wiki-viewer/agents/wiki-viewer-skill";

function useCopyCurl(currentPath: string | null) {
	const [copied, setCopied] = useState(false);
	const copy = useCallback(async () => {
		const origin =
			typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
		const filePath = currentPath ?? "<path/to/file.md>";
		// Registration-flow curl trace
		const curl = [
			`# 1. Register`,
			`REG=$(curl -s -X POST -H 'Content-Type: application/json' \\`,
			`  -d '{"id":"ai:claude","displayName":"Claude"}' \\`,
			`  ${origin}/api/agent/register)`,
			`REG_ID=$(echo $REG | jq -r .registrationId)`,
			``,
			`# 2. Approve in AI Panel, then poll:`,
			`curl -s ${origin}/api/agent/register/$REG_ID`,
			`# → {"status":"approved","token":"..."}`,
			`TOKEN=<paste token here>`,
			``,
			`# 3. Read snapshot`,
			`curl -s -H "Authorization: Bearer $TOKEN" \\`,
			`  -H "X-Agent-Id: ai:claude" \\`,
			`  ${origin}/api/agent/files/${filePath}`,
		].join("\n");
		await navigator.clipboard.writeText(curl);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [currentPath]);
	return { copied, copy };
}

function useCopyButton(getText: () => string): { copied: boolean; copy: () => Promise<void> } {
	const [copied, setCopied] = useState(false);
	const copy = useCallback(async () => {
		await navigator.clipboard.writeText(getText());
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [getText]);
	return { copied, copy };
}

export function AIPanel({ currentPath }: { currentPath?: string | null }) {
	const isOpen = useAIPanelStore((s) => s.isOpen);
	const close = useAIPanelStore((s) => s.close);
	const activity = useAIPanelStore((s) => s.activity);
	const connections = useAIPanelStore((s) => s.connections);
	const rateLimit = useAIPanelStore((s) => s.rateLimit);
	const loadActivity = useAIPanelStore((s) => s.loadActivity);
	const { copied, copy } = useCopyCurl(currentPath ?? null);
	const [bootstrapPrompt, setBootstrapPrompt] = useState<string>("");
	const panelRef = useRef<HTMLElement>(null);

	const origin =
		typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
	const getSkillCli = useCallback(() => SKILL_CLI, []);
	const getBootstrapPrompt = useCallback(
		() => bootstrapPrompt.replace(/\$WIKI_URL/g, origin),
		[bootstrapPrompt, origin]
	);
	const getMcpRegister = useCallback(
		() =>
			`npx wiki-viewer-mcp register --url ${origin} --id ai:myagent --name "My Agent"`,
		[origin]
	);
	const getMcpJson = useCallback(
		() =>
			JSON.stringify(
				{
					servers: {
						"wiki-viewer": {
							command: "npx",
							args: ["wiki-viewer-mcp"],
							env: {
								WIKI_VIEWER_URL: origin,
								WIKI_VIEWER_TOKEN: "<token from register>",
								WIKI_VIEWER_AGENT_ID: "ai:myagent",
							},
						},
					},
				},
				null,
				2
			),
		[origin]
	);
	const skillCli = useCopyButton(getSkillCli);
	const bootstrapCopy = useCopyButton(getBootstrapPrompt);
	const mcpRegister = useCopyButton(getMcpRegister);
	const mcpJson = useCopyButton(getMcpJson);

	// Keyboard: Esc closes
	useEffect(() => {
		if (!isOpen) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") close();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isOpen, close]);

	// Focus trap: focus panel when open
	useEffect(() => {
		if (isOpen) panelRef.current?.focus();
	}, [isOpen]);

	// Poll while open
	useEffect(() => {
		if (!isOpen) return;
		void loadActivity();
		const id = setInterval(() => void loadActivity(), 10_000);
		return () => clearInterval(id);
	}, [isOpen, loadActivity]);

	// Fetch install JSON once on open for live bootstrap prompt
	useEffect(() => {
		if (!isOpen) return;
		void fetch("/api/agents/install")
			.then((r) => r.json())
			.then((d: { bootstrapPrompt?: string }) => {
				if (d.bootstrapPrompt) setBootstrapPrompt(d.bootstrapPrompt);
			})
			.catch(() => undefined);
	}, [isOpen]);

	if (!isOpen) return null;

	return (
		<>
			{/* Backdrop */}
			<div
				className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
				onClick={close}
				aria-hidden
			/>

			{/* Panel */}
			<aside
				ref={panelRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="AI Agent Panel"
				className="fixed right-0 top-0 bottom-0 z-50 flex w-80 flex-col border-l border-border bg-background shadow-xl outline-none"
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
					<div className="flex items-center gap-2">
						<Bot className="h-4 w-4 text-muted-foreground" />
						<span className="text-sm font-semibold">AI Agent</span>
					</div>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 w-7 p-0"
						onClick={close}
						title="Close panel (Esc)"
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>

				{/* Scrollable body */}
				<div className="flex-1 overflow-y-auto space-y-5 px-4 py-4">
					<SignedInUser />

					{/* Bridge endpoint */}
					<section className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							Bridge Endpoint
						</h3>
						<div className="rounded-md border border-border bg-muted/40 p-3 space-y-2">
							<div className="flex items-center gap-2">
								<code className="flex-1 text-xs font-mono text-foreground/80 truncate">
									{origin}
								</code>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 w-6 p-0 shrink-0"
									title="Copy curl example"
									onClick={() => void copy()}
								>
									{copied ? (
										<Check className="h-3.5 w-3.5 text-green-500" />
									) : (
										<Copy className="h-3.5 w-3.5" />
									)}
								</Button>
							</div>
							<p className="text-[10px] text-muted-foreground/70">
								Copy icon copies a registration-flow <code className="bg-muted px-0.5 rounded">curl</code> trace for the current file.
							</p>
						</div>
					</section>

					{/* Install for AI agents */}
					<section className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							Install for AI Agents
						</h3>
						<div className="rounded-md border border-border bg-muted/40 p-3 space-y-3">
							<div className="space-y-1">
								<p className="text-[10px] text-muted-foreground/70">
									MCP server <span className="text-muted-foreground/50">(Claude Code, Cursor, Codex):</span>
								</p>
								<p className="text-[10px] text-muted-foreground/50">1. Register &amp; get a token:</p>
								<div className="flex items-center gap-2">
									<code className="flex-1 text-[10px] font-mono text-foreground/80 truncate bg-muted rounded px-1 py-0.5">
										{getMcpRegister()}
									</code>
									<Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy register command" onClick={() => void mcpRegister.copy()}>
										{mcpRegister.copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
									</Button>
								</div>
								<p className="text-[10px] text-muted-foreground/50 pt-1">2. Approve below, then add to your <code className="bg-muted px-0.5 rounded">mcp.json</code>:</p>
								<Button size="sm" variant="outline" className="h-7 w-full text-xs gap-1.5" onClick={() => void mcpJson.copy()}>
									{mcpJson.copied
										? <><Check className="h-3.5 w-3.5 text-green-500" /> Copied!</>
										: <><Copy className="h-3.5 w-3.5" /> Copy mcp.json</>}
								</Button>
							</div>
							<div className="h-px bg-border/60" />
							<div className="space-y-1">
								<p className="text-[10px] text-muted-foreground/70">Agent Skills standard:</p>
								<div className="flex items-center gap-2">
									<code className="flex-1 text-[10px] font-mono text-foreground/80 truncate bg-muted rounded px-1 py-0.5">
										{SKILL_CLI}
									</code>
									<Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy CLI command" onClick={() => void skillCli.copy()}>
										{skillCli.copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
									</Button>
								</div>
							</div>
							<div className="space-y-1">
								<p className="text-[10px] text-muted-foreground/70">Any agent (paste into chat):</p>
								<Button size="sm" variant="outline" className="h-7 w-full text-xs gap-1.5" onClick={() => void bootstrapCopy.copy()} disabled={!bootstrapPrompt}>
									{bootstrapCopy.copied
										? <><Check className="h-3.5 w-3.5 text-green-500" /> Copied!</>
										: <><Copy className="h-3.5 w-3.5" /> Copy bootstrap prompt</>}
								</Button>
							</div>
							<div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
								<a href="/api/agents/skill.tar.gz" download className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
									<Download className="h-3 w-3" /> skill (.tar.gz)
								</a>
								<a href="/api/agents/skill" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
									<ExternalLink className="h-3 w-3" /> skill markdown
								</a>
								<a href="/api/agents/install" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
									<ExternalLink className="h-3 w-3" /> install JSON
								</a>
							</div>
						</div>
					</section>

					{/* Token / Agents */}
					<TokenSection />

					{/* Active connections */}
					<section className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							Active Connections{" "}
							<span className="normal-case font-normal text-muted-foreground/50">
								(last 5 min)
							</span>
						</h3>
						<div className="rounded-md border border-border bg-muted/40 p-3">
							{connections.length === 0 ? (
								<p className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
									<Wifi className="h-3.5 w-3.5" />
									No recent activity
								</p>
							) : (
								<ul className="space-y-1.5">
									{connections.map((c) => (
										<li key={c.by} className="flex items-center justify-between text-xs">
											<span className="font-mono text-foreground/80 truncate">{c.by}</span>
											<span className="text-muted-foreground shrink-0">
												{c.opCount} op{c.opCount !== 1 ? "s" : ""}
											</span>
										</li>
									))}
								</ul>
							)}
						</div>
					</section>

					{/* Recent activity */}
					<section className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							Recent Activity
						</h3>
						<div className="rounded-md border border-border bg-muted/40 px-3 py-1 max-h-72 overflow-y-auto">
							{activity.length === 0 ? (
								<p className="text-xs text-muted-foreground/60 py-2">No events recorded</p>
							) : (
								activity.map((ev) => (
									<ActivityRow key={`${ev.path}-${ev.id}`} event={ev} />
								))
							)}
						</div>
					</section>

					{/* Settings */}
					<section className="space-y-2">
						<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
							Settings
						</h3>
						<div className="rounded-md border border-border bg-muted/40 p-3 space-y-1.5">
							<div className="flex items-center justify-between text-xs">
								<span className="text-muted-foreground">Rate limit</span>
								<span className="font-mono">
									{rateLimit !== null ? `${rateLimit} ops/min` : "--"}
								</span>
							</div>
							<p className="text-[10px] text-muted-foreground/60">
								Override with <code className="bg-muted px-0.5 rounded">AGENT_RATE_LIMIT</code> env var.
							</p>
						</div>
					</section>

					{/* Docs link */}
					<section>
						<a
							href="/docs/agent-collab-plan.md"
							target="_blank"
							rel="noreferrer"
							className="text-xs text-primary underline hover:no-underline"
						>
							Agent collaboration docs →
						</a>
					</section>
				</div>
			</aside>
		</>
	);
}

function SignedInUser() {
	const { data: session } = authClient.useSession();
	if (!session?.user) return null;
	return (
		<div className="flex items-center justify-between rounded-md border border-border bg-muted/40 p-3">
			<div className="text-sm min-w-0">
				<div className="font-medium truncate">{session.user.name}</div>
				<div className="text-xs text-muted-foreground truncate">{session.user.email}</div>
			</div>
			<button
				type="button"
				onClick={async () => {
					await authClient.signOut();
					window.location.href = "/signin";
				}}
				className="ml-2 shrink-0 text-xs px-2 py-1 rounded border border-border hover:bg-accent"
			>
				Sign out
			</button>
		</div>
	);
}
