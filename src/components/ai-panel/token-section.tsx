"use client";

import { useState, useEffect, useCallback } from "react";
import { CheckCircle, XCircle, Clock, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingReg {
	registrationId: string;
	agentId: string;
	displayName: string;
	requestedScope: { paths: string[]; ops: string[] };
	requestedAt: string;
}

interface RegisteredAgent {
	id: string;
	displayName: string;
	scope: { paths: string[]; ops: string[] };
	createdAt: string;
	lastSeen: string;
}

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ScopeTag({ scope }: { scope: { paths: string[]; ops: string[] } }) {
	return (
		<span className="text-[10px] text-muted-foreground/70 font-mono">
			{scope.paths.join(", ")} · {scope.ops.join(",")}
		</span>
	);
}

function PendingRow({
	reg,
	onApprove,
	onDeny,
}: {
	reg: PendingReg;
	onApprove: (id: string) => Promise<void>;
	onDeny: (id: string) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	async function handle(fn: (id: string) => Promise<void>) {
		setBusy(true);
		try {
			await fn(reg.registrationId);
		} finally {
			setBusy(false);
		}
	}

	return (
		<li className="py-1.5 border-b border-border/40 last:border-0">
			<div className="flex items-start justify-between gap-1">
				<div className="min-w-0">
					<p className="text-xs font-mono truncate">{reg.displayName}</p>
					<p className="text-[10px] text-muted-foreground/60 truncate">{reg.agentId}</p>
					<ScopeTag scope={reg.requestedScope} />
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<Button
						size="sm"
						variant="default"
						className="h-6 px-2 text-[10px]"
						disabled={busy}
						onClick={() => void handle(onApprove)}
						title="Approve"
					>
						<CheckCircle className="h-3 w-3 mr-0.5" />
						Approve
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
						disabled={busy}
						onClick={() => void handle(onDeny)}
						title="Deny"
					>
						<XCircle className="h-3 w-3 mr-0.5" />
						Deny
					</Button>
				</div>
			</div>
			<p className="text-[10px] text-muted-foreground/50 mt-0.5">
				Requested {relativeTime(reg.requestedAt)}
			</p>
		</li>
	);
}

function AgentRow({
	agent,
	onRevoke,
}: {
	agent: RegisteredAgent;
	onRevoke: (id: string) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);

	return (
		<li className="py-1.5 border-b border-border/40 last:border-0">
			<div className="flex items-start justify-between gap-1">
				<div className="min-w-0">
					<p className="text-xs font-mono truncate">{agent.displayName}</p>
					<p className="text-[10px] text-muted-foreground/60 truncate">{agent.id}</p>
					<ScopeTag scope={agent.scope} />
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="h-6 w-6 p-0 shrink-0 text-destructive hover:text-destructive"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await onRevoke(agent.id);
						} finally {
							setBusy(false);
						}
					}}
					title="Revoke agent"
				>
					<Trash2 className="h-3 w-3" />
				</Button>
			</div>
			<p className="text-[10px] text-muted-foreground/50 mt-0.5">
				Last seen {relativeTime(agent.lastSeen)}
			</p>
		</li>
	);
}

// ── Main component ────────────────────────────────────────────────────────────

export function TokenSection() {
	const [pending, setPending] = useState<PendingReg[]>([]);
	const [agents, setAgents] = useState<RegisteredAgent[]>([]);
	const [ownerReady, setOwnerReady] = useState(false);

	// Bootstrap owner cookie on first mount (localhost only)
	useEffect(() => {
		fetch("/api/owner/init", { credentials: "same-origin" })
			.then((r) => {
				if (r.ok || r.status === 204) setOwnerReady(true);
			})
			.catch(() => {
				// Non-localhost: owner init will fail — that's expected for remote
				setOwnerReady(true);
			});
	}, []);

	const fetchPending = useCallback(async () => {
		try {
			const r = await fetch("/api/agent/admin/registrations", { credentials: "same-origin" });
			if (!r.ok) return;
			const data = (await r.json()) as { pending: PendingReg[] };
			setPending(data.pending);
		} catch {
			// Ignore fetch errors (offline, etc.)
		}
	}, []);

	const fetchAgents = useCallback(async () => {
		try {
			const r = await fetch("/api/agent/admin/agents", { credentials: "same-origin" });
			if (!r.ok) return;
			const data = (await r.json()) as { agents: RegisteredAgent[] };
			setAgents(data.agents);
		} catch {
			// Ignore fetch errors
		}
	}, []);

	// Poll pending every 5s, agents every 30s
	useEffect(() => {
		if (!ownerReady) return;
		void fetchPending();
		void fetchAgents();
		const pendingId = setInterval(() => void fetchPending(), 5_000);
		const agentsId = setInterval(() => void fetchAgents(), 30_000);
		return () => {
			clearInterval(pendingId);
			clearInterval(agentsId);
		};
	}, [ownerReady, fetchPending, fetchAgents]);

	const handleApprove = useCallback(
		async (regId: string) => {
			const r = await fetch(`/api/agent/admin/registrations/${regId}/approve`, {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (r.ok) {
				toast.success("Agent approved");
				await Promise.all([fetchPending(), fetchAgents()]);
			} else {
				toast.error("Failed to approve agent");
			}
		},
		[fetchPending, fetchAgents],
	);

	const handleDeny = useCallback(
		async (regId: string) => {
			const r = await fetch(`/api/agent/admin/registrations/${regId}/deny`, {
				method: "POST",
				credentials: "same-origin",
			});
			if (r.ok) {
				toast.success("Registration denied");
				await fetchPending();
			} else {
				toast.error("Failed to deny registration");
			}
		},
		[fetchPending],
	);

	const handleRevoke = useCallback(
		async (agentId: string) => {
			const r = await fetch(
				`/api/agent/admin/agents/${encodeURIComponent(agentId)}/revoke`,
				{ method: "POST", credentials: "same-origin" },
			);
			if (r.ok) {
				toast.success("Agent revoked");
				await fetchAgents();
			} else {
				toast.error("Failed to revoke agent");
			}
		},
		[fetchAgents],
	);

	return (
		<section className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
					Agents · approve &amp; manage access
				</h3>
				<Button
					size="sm"
					variant="ghost"
					className="h-5 w-5 p-0"
					title="Refresh"
					onClick={() => void Promise.all([fetchPending(), fetchAgents()])}
				>
					<RefreshCw className="h-3 w-3" />
				</Button>
			</div>

			{/* Pending registrations */}
			{pending.length > 0 && (
				<div className="rounded-md border border-amber-500/40 bg-amber-50/10 p-2">
					<p className="text-[10px] font-semibold uppercase tracking-widest text-amber-600/80 mb-1 flex items-center gap-1">
						<Clock className="h-3 w-3" />
						Waiting for your approval ({pending.length})
					</p>
					<ul>
						{pending.map((reg) => (
							<PendingRow
								key={reg.registrationId}
								reg={reg}
								onApprove={handleApprove}
								onDeny={handleDeny}
							/>
						))}
					</ul>
				</div>
			)}

			{/* Registered agents */}
			<div className="rounded-md border border-border bg-muted/40 p-2">
				{agents.length === 0 ? (
					<p className="text-xs text-muted-foreground/60 py-1">
						No assistants connected yet.{" "}
						<span className="text-muted-foreground/40">
							Connect one above; once it requests access it’ll appear here
							for you to approve.
						</span>
					</p>
				) : (
					<ul>
						{agents.map((agent) => (
							<AgentRow key={agent.id} agent={agent} onRevoke={handleRevoke} />
						))}
					</ul>
				)}
			</div>

			<p className="text-[10px] text-muted-foreground/60 leading-relaxed">
				Each assistant gets its own access that you can revoke anytime. New
				requests appear above for your approval before they can read or edit
				anything.
			</p>
		</section>
	);
}
