"use client";

import {
	Copy,
	Check,
	Globe,
	Loader2,
	Lock,
	Trash2,
	Clock,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { showSuccess, showError } from "@/lib/toast";
import { wsFetch } from "@/lib/workspace-client";

interface Share {
	id: string;
	token: string;
	url: string;
	hasPassword: boolean;
	expiresAt: string | null;
	createdAt: string;
	viewCount: number;
	isExpired: boolean;
}

interface ShareDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	filePath: string;
}

export function ShareDialog({
	open,
	onOpenChange,
	filePath,
}: ShareDialogProps) {
	const [shares, setShares] = useState<Share[]>([]);
	const [loading, setLoading] = useState(true);
	const [creating, setCreating] = useState(false);

	// Form fields
	const [password, setPassword] = useState("");
	const [enablePassword, setEnablePassword] = useState(false);
	const [enableExpiry, setEnableExpiry] = useState(false);
	const [expiryDays, setExpiryDays] = useState("7");

	// Copied state per share token
	const [copiedToken, setCopiedToken] = useState<string | null>(null);

	const loadShares = useCallback(async () => {
		setLoading(true);
		try {
			const res = await wsFetch(
				`/api/share?path=${encodeURIComponent(filePath)}`,
			);
			if (res.ok) {
				const data = await res.json();
				setShares(data.shares ?? []);
			}
		} catch {
			// silently fail
		}
		setLoading(false);
	}, [filePath]);

	useEffect(() => {
		if (open) void loadShares();
	}, [open, loadShares]);

	const handleCreate = async () => {
		setCreating(true);
		try {
			const body: Record<string, unknown> = { path: filePath };
			if (enablePassword && password.trim()) {
				body.password = password.trim();
			}
			if (enableExpiry && expiryDays) {
				const d = new Date();
				d.setDate(d.getDate() + Number(expiryDays));
				body.expiresAt = d.toISOString();
			}
			const res = await wsFetch("/api/share", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const e = await res.json();
				showError(e.error ?? "Failed to create share link");
				return;
			}
			showSuccess("Share link created");
			setPassword("");
			setEnablePassword(false);
			setEnableExpiry(false);
			setExpiryDays("7");
			await loadShares();
		} catch {
			showError("Failed to create share link");
		} finally {
			setCreating(false);
		}
	};

	const handleRevoke = async (token: string) => {
		try {
			const res = await fetch(`/api/share/${token}`, { method: "DELETE" });
			if (!res.ok) {
				showError("Failed to revoke share link");
				return;
			}
			showSuccess("Share link revoked");
			await loadShares();
		} catch {
			showError("Failed to revoke share link");
		}
	};

	const copyLink = (url: string, token: string) => {
		const fullUrl = `${window.location.origin}${url}`;
		void navigator.clipboard.writeText(fullUrl);
		setCopiedToken(token);
		setTimeout(() => setCopiedToken(null), 2000);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Share document</DialogTitle>
					<DialogDescription>
						Create a public link to share this document as read-only.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{/* Create new share */}
					<div className="rounded-sm border border-border p-3 space-y-3">
						<h3 className="text-sm font-medium">New share link</h3>

						{/* Password toggle */}
						<div className="flex items-center justify-between">
							<Label htmlFor="share-pwd" className="text-xs gap-1.5 flex items-center">
								<Lock className="h-3 w-3 text-muted-foreground" />
								Password protect
							</Label>
							<Switch
								id="share-pwd"
								checked={enablePassword}
								onCheckedChange={setEnablePassword}
							/>
						</div>
						{enablePassword && (
							<Input
								type="password"
								placeholder="Set a password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						)}

						{/* Expiry toggle */}
						<div className="flex items-center justify-between">
							<Label htmlFor="share-expiry" className="text-xs gap-1.5 flex items-center">
								<Clock className="h-3 w-3 text-muted-foreground" />
								Set expiration
							</Label>
							<Switch
								id="share-expiry"
								checked={enableExpiry}
								onCheckedChange={setEnableExpiry}
							/>
						</div>
						{enableExpiry && (
							<div className="flex items-center gap-2">
								<Input
									type="number"
									min={1}
									max={365}
									value={expiryDays}
									onChange={(e) => setExpiryDays(e.target.value)}
									className="w-20"
								/>
								<span className="text-xs text-muted-foreground">days</span>
							</div>
						)}

						<Button
							size="sm"
							className="w-full gap-1.5"
							onClick={handleCreate}
							disabled={creating}
						>
							{creating ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Globe className="h-3.5 w-3.5" />
							)}
							Create link
						</Button>
					</div>

					{/* Existing shares */}
					<div className="space-y-2">
						<h3 className="text-xs font-medium text-muted-foreground">
							{shares.length > 0
								? `Active links (${shares.length})`
								: loading
									? "Loading..."
									: "No active links"}
						</h3>
						{loading && (
							<div className="flex justify-center py-2">
								<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
							</div>
						)}
						{shares.map((share) => (
							<div
								key={share.id}
								className="flex items-center gap-2 rounded-sm border border-border p-2"
							>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-1.5">
										<span className="text-xs font-mono truncate">
											{window.location.origin}/s/{share.token}
										</span>
									</div>
									<div className="flex items-center gap-2 mt-0.5">
										{share.hasPassword && (
											<span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
												<Lock className="h-2.5 w-2.5" />
												pwd
											</span>
										)}
										{share.expiresAt && (
											<span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
												<Clock className="h-2.5 w-2.5" />
												{formatExpiry(share.expiresAt)}
											</span>
										)}
										<span className="text-[10px] text-muted-foreground">
											{share.viewCount} view
											{share.viewCount !== 1 ? "s" : ""}
										</span>
										{share.isExpired && (
											<span className="text-[10px] text-destructive">
												expired
											</span>
										)}
									</div>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<Button
										size="sm"
										variant="ghost"
										className="h-7 w-7 p-0"
										title="Copy link"
										onClick={() => copyLink(share.url, share.token)}
									>
										{copiedToken === share.token ? (
											<Check className="h-3.5 w-3.5 text-success" />
										) : (
											<Copy className="h-3.5 w-3.5" />
										)}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="h-7 w-7 p-0 text-destructive hover:text-destructive"
										title="Revoke link"
										onClick={() => handleRevoke(share.token)}
									>
										<Trash2 className="h-3.5 w-3.5" />
									</Button>
								</div>
							</div>
						))}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function formatExpiry(iso: string): string {
	const d = new Date(iso);
	const now = new Date();
	const ms = d.getTime() - now.getTime();
	if (ms <= 0) return "expired";
	const days = Math.floor(ms / 86400000);
	const hours = Math.floor((ms % 86400000) / 3600000);
	if (days > 0) return `${days}d`;
	if (hours > 0) return `${hours}h`;
	return "<1h";
}
