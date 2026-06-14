"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { X, Copy, Check, Bot, Wifi, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAIPanelStore } from "@/stores/ai-panel-store";
import { TokenSection } from "./token-section";
import { ActivityFeed } from "./activity-row";
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
				className="fixed inset-0 z-40 bg-overlay backdrop-blur-[1px]"
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
				className="fixed right-0 top-0 bottom-0 z-50 flex w-[90vw] max-w-sm md:w-80 flex-col border-l border-border bg-background shadow-xl outline-none"
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
					{/* What this does — one line */}
					<section className="rounded-md border border-border bg-muted/30 p-3">
						<p className="text-sm font-medium text-foreground">
							Work with this wiki using AI
						</p>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
							Connect Claude, Cursor, ChatGPT, and more. Pick by what you want —
							each option gives a copy-paste setup. You approve every assistant
							in <span className="font-medium text-foreground/80">Agents</span> below before it gets access.
						</p>
					</section>

					{/* Choose by goal */}
					<section className="space-y-3">
						{/* Goal 1: collaborate (one-off instructions + permanent skill) */}
						<div className="rounded-md border border-border bg-muted/40 p-3 space-y-1.5">
							<p className="text-xs font-semibold text-foreground">
								Co-write docs with you
							</p>
							<p className="text-[10px] text-muted-foreground/70">
								Edits arrive as suggestions with comments you accept or revert.
								No MCP needed.
							</p>
							<Button size="sm" variant="outline" className="h-7 w-full text-xs gap-1.5" onClick={() => void bootstrapCopy.copy()} disabled={!bootstrapPrompt}>
								{bootstrapCopy.copied
									? <><Check className="h-3.5 w-3.5 text-green-500" /> Copied!</>
									: <><Copy className="h-3.5 w-3.5" /> Paste into any chatbot</>}
							</Button>
							<p className="text-[10px] text-muted-foreground/50 pt-1">
								Or install once so it sticks{" "}
								<span className="text-muted-foreground/40">· Claude, OpenCode</span>:
							</p>
							<div className="flex items-center gap-2">
								<code className="flex-1 text-[10px] font-mono text-foreground/80 truncate bg-muted rounded px-1 py-0.5">
									{SKILL_CLI}
								</code>
								<Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy this command" onClick={() => void skillCli.copy()}>
									{skillCli.copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
								</Button>
							</div>
						</div>

						{/* Goal 2: raw filework */}
						<div className="rounded-md border border-border bg-muted/40 p-3 space-y-1.5">
							<p className="text-xs font-semibold text-foreground">
								Edit files directly{" "}
								<span className="font-normal text-muted-foreground/60">· Claude Code, Cursor, Codex</span>
							</p>
							<p className="text-[10px] text-muted-foreground/70">
								Native read / search / edit tools over MCP. Run to request access:
							</p>
							<div className="flex items-center gap-2">
								<code className="flex-1 text-[10px] font-mono text-foreground/80 truncate bg-muted rounded px-1 py-0.5">
									{getMcpRegister()}
								</code>
								<Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0" title="Copy this command" onClick={() => void mcpRegister.copy()}>
									{mcpRegister.copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
								</Button>
							</div>
							<p className="text-[10px] text-muted-foreground/50">Approve in <span className="font-medium text-foreground/70">Agents</span>, then add to your tool:</p>
							<Button size="sm" variant="outline" className="h-7 w-full text-xs gap-1.5" onClick={() => void mcpJson.copy()}>
								{mcpJson.copied
									? <><Check className="h-3.5 w-3.5 text-green-500" /> Copied!</>
									: <><Copy className="h-3.5 w-3.5" /> Copy config (mcp.json)</>}
							</Button>
						</div>

						<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
							<span className="text-[10px] text-muted-foreground/50">For developers:</span>
							<button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
								{copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />} curl example
							</button>
							<a href="/api/agents/skill" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
								<ExternalLink className="h-3 w-3" /> skill
							</a>
							<a href="/api/agents/install" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline">
								<ExternalLink className="h-3 w-3" /> install JSON
							</a>
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
						<div className="rounded-md border border-border bg-muted/40 px-3 py-2 max-h-72 overflow-y-auto">
							<ActivityFeed activity={activity} />
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
