"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetClose } from "@/components/ui/sheet";
import { showError } from "@/lib/toast";
import { authClient } from "@/lib/auth/client";

interface AuthSettings {
	allowedEmails: string[];
	allowedDomains: string[];
	source: "config" | "env";
	envFallbackActive: boolean;
	rateLimit?: number;
}

function listToText(list: string[]): string {
	return list.join("\n");
}

function textToList(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function AuthSettingsSheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [source, setSource] = useState<"config" | "env">("env");
	const [emailsText, setEmailsText] = useState("");
	const [domainsText, setDomainsText] = useState("");
	const [rateLimit, setRateLimit] = useState<number | null>(null);
	const { data: session } = authClient.useSession();

	// Admin management
	const [isAdmin, setIsAdmin] = useState(false);
	const [admins, setAdmins] = useState<string[]>([]);
	const [adminUsers, setAdminUsers] = useState<Array<{ id: string; email: string; name: string }>>([]);
	const [adminError, setAdminError] = useState<string | null>(null);
	const [adminWorking, setAdminWorking] = useState<string | null>(null);
	// Add-user form
	const [newUserEmail, setNewUserEmail] = useState("");
	const [newUserName, setNewUserName] = useState("");
	const [creatingUser, setCreatingUser] = useState(false);
	const [createdUser, setCreatedUser] = useState<{ email: string; tempPassword: string } | null>(null);

	const loadAdmins = useCallback(async () => {
		try {
			const res = await fetch("/api/system/admins");
			if (!res.ok) return;
			const d: { admins?: string[]; isAdmin?: boolean; users?: Array<{ id: string; email: string; name: string }> } =
				await res.json();
			setIsAdmin(!!d.isAdmin);
			setAdmins(d.admins ?? []);
			setAdminUsers(d.users ?? []);
		} catch {
			/* ignore */
		}
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/system/auth-settings");
			if (!res.ok) throw new Error("Failed to load settings");
			const data: AuthSettings = await res.json();
			setEmailsText(listToText(data.allowedEmails));
			setDomainsText(listToText(data.allowedDomains));
			setSource(data.source);
			setRateLimit(typeof data.rateLimit === "number" ? data.rateLimit : null);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) {
			void load();
			void loadAdmins();
		}
	}, [open, load, loadAdmins]);

	async function handleSave() {
		setSaving(true);
		setError(null);
		try {
			const res = await fetch("/api/system/auth-settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					allowedEmails: textToList(emailsText),
					allowedDomains: textToList(domainsText),
				}),
			});
			const data: { error?: string; source?: "config" | "env" } =
				await res.json();
			if (!res.ok) {
				setError(data.error ?? "Save failed");
				showError(data.error ?? "Save failed");
				return;
			}
			if (data.source) setSource(data.source);
			onOpenChange(false);
		} catch {
			setError("Save failed");
		} finally {
			setSaving(false);
		}
	}

	const noRestriction =
		textToList(emailsText).length === 0 &&
		textToList(domainsText).length === 0;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="w-80 sm:max-w-md flex flex-col border-l border-border p-0"
			>
				{/* Header — matches AI panel chrome */}
				<div className="flex items-center justify-between border-b border-border px-4 py-3 shrink-0">
					<span className="text-sm font-semibold">Settings</span>
					<SheetClose className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring">
						<X className="h-3.5 w-3.5" />
						<span className="sr-only">Close</span>
					</SheetClose>
				</div>

				{loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
						{/* Account */}
						{session?.user && (
							<section className="space-y-2">
								<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
									Account
								</h3>
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
							</section>
						)}

						{/* Signup allowlist */}
						<section className="space-y-2">
							<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
								Signup allowlist
							</h3>
						<p className="text-xs leading-relaxed text-muted-foreground">
							Control who can create an account. Leave both lists empty to
							allow any email. Saving here overrides the{" "}
							<code className="bg-muted px-0.5 rounded">AUTH_ALLOWED_EMAILS</code>{" "}
							and{" "}
							<code className="bg-muted px-0.5 rounded">AUTH_ALLOWED_DOMAIN</code>{" "}
							environment variables.
						</p>
						{source === "env" && (
							<div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
								<AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
								<span>
									Current values come from environment variables. Saving moves
									the allowlist into config and takes precedence going forward.
								</span>
							</div>
						)}

						<div className="space-y-1.5">
							<label
								htmlFor="allowed-emails"
								className="text-sm font-medium"
							>
								Allowed emails
							</label>
							<p className="text-xs text-muted-foreground">
								One per line (or comma-separated). Exact match,
								case-insensitive.
							</p>
							<textarea
								id="allowed-emails"
								value={emailsText}
								onChange={(e) => setEmailsText(e.target.value)}
								spellCheck={false}
								rows={5}
								placeholder="alice@example.com&#10;bob@example.com"
								className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary"
							/>
						</div>

						<div className="space-y-1.5">
							<label
								htmlFor="allowed-domains"
								className="text-sm font-medium"
							>
								Allowed domains
							</label>
							<p className="text-xs text-muted-foreground">
								One per line (or comma-separated). Matches any email at that
								domain.
							</p>
							<textarea
								id="allowed-domains"
								value={domainsText}
								onChange={(e) => setDomainsText(e.target.value)}
								spellCheck={false}
								rows={4}
								placeholder="example.com&#10;trusted.org"
								className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary"
							/>
						</div>

						{noRestriction && (
							<div className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-ink">
								<AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
								<span>
									Both lists are empty. Anyone with the signup URL can create an
									account.
								</span>
							</div>
						)}

						{error && (
							<div className="flex items-center gap-1.5 text-xs text-destructive">
								<AlertCircle className="h-3.5 w-3.5 shrink-0" />
								{error}
							</div>
						)}
						</section>

						{/* Admins — only visible to admins */}
						{isAdmin && (
							<section className="space-y-2">
								<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
									Admins
								</h3>
								<p className="text-xs leading-relaxed text-muted-foreground">
									Admins can create workspaces, add users, and manage access.
								</p>
								{adminError && (
									<div className="flex items-center gap-1.5 text-xs text-destructive">
										<AlertCircle className="h-3.5 w-3.5 shrink-0" />
										{adminError}
									</div>
								)}

								{/* Add user */}
								<div className="space-y-2 rounded-md border border-border p-3">
									<div className="text-xs font-medium">Add user</div>
									{createdUser ? (
										<div className="space-y-2">
											<p className="text-xs text-muted-foreground">
												Created <span className="font-medium text-foreground">{createdUser.email}</span>. Share this temporary password now, it will not be shown again.
											</p>
											<div className="flex items-center gap-2">
												<code className="flex-1 rounded bg-muted px-2 py-1.5 font-mono text-sm select-all">{createdUser.tempPassword}</code>
												<button
													type="button"
													className="shrink-0 text-xs px-2 py-1 rounded border border-border hover:bg-accent"
													onClick={() => void navigator.clipboard?.writeText(createdUser.tempPassword)}
												>
													Copy
												</button>
											</div>
											<button
												type="button"
											className="text-xs text-muted-foreground hover:text-foreground"
											onClick={() => { setCreatedUser(null); setNewUserEmail(""); setNewUserName(""); void loadAdmins(); }}
										>
											Done
										</button>
										</div>
									) : (
										<div className="space-y-2">
											<input
												type="email"
												value={newUserEmail}
												onChange={(e) => setNewUserEmail(e.target.value)}
												placeholder="email@team.com"
												className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary"
											/>
											<input
												type="text"
												value={newUserName}
												onChange={(e) => setNewUserName(e.target.value)}
												placeholder="Name (optional)"
												className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary"
											/>
											<Button
												size="sm"
												className="w-full gap-1.5"
												disabled={creatingUser || !newUserEmail.trim()}
												onClick={async () => {
													setCreatingUser(true);
													setAdminError(null);
													try {
														const res = await fetch("/api/system/users", {
															method: "POST",
															headers: { "Content-Type": "application/json" },
															body: JSON.stringify({ email: newUserEmail.trim(), name: newUserName.trim() }),
														});
														const d: { ok?: boolean; email?: string; tempPassword?: string; error?: string; message?: string } = await res.json();
														if (!res.ok || !d.tempPassword) {
															setAdminError(d.message ?? d.error ?? "Failed to create user");
														} else {
															setCreatedUser({ email: d.email ?? newUserEmail.trim(), tempPassword: d.tempPassword });
														}
													} catch {
														setAdminError("Network error");
													} finally {
														setCreatingUser(false);
													}
												}}
											>
												{creatingUser && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
												Create user
											</Button>
										</div>
									)}
								</div>
								<div className="space-y-1 rounded-md border border-border overflow-hidden">
									{adminUsers.map((u) => {
										const isAdminUser = admins.includes(u.id);
										return (
											<div key={u.id} className="flex items-center justify-between px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors">
												<div className="text-sm min-w-0">
													<div className="font-medium truncate">{u.name}</div>
													<div className="text-xs text-muted-foreground truncate">{u.email}</div>
												</div>
												<button
													type="button"
													disabled={adminWorking === u.id}
													className="ml-2 shrink-0 text-xs px-2 py-1 rounded border border-border hover:bg-accent disabled:opacity-50"
													onClick={async () => {
														setAdminWorking(u.id);
														setAdminError(null);
														try {
															const res = await fetch("/api/system/admins", {
																method: isAdminUser ? "DELETE" : "POST",
																headers: { "Content-Type": "application/json" },
																body: JSON.stringify({ userId: u.id }),
															});
															const d: { ok?: boolean; admins?: string[]; error?: string; message?: string } = await res.json();
															if (!res.ok) {
																setAdminError(d.message ?? d.error ?? "Failed");
															} else if (d.admins) {
																setAdmins(d.admins);
															}
														} catch {
															setAdminError("Network error");
														} finally {
															setAdminWorking(null);
														}
													}}
												>
													{adminWorking === u.id ? (
														<Loader2 className="h-3 w-3 animate-spin" />
													) : isAdminUser ? "Demote" : "Promote"}
												</button>
											</div>
										);
									})}
									{adminUsers.length === 0 && (
										<div className="px-3 py-2 text-xs text-muted-foreground">No users yet.</div>
									)}
								</div>
								{/* TODO: per-workspace access editor (PATCH /api/system/workspaces/[id] allowedUserIds) */}
							</section>
						)}

						{/* Agent rate limit */}
						<section className="space-y-2">
							<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
								Agent rate limit
							</h3>
							<div className="rounded-md border border-border bg-muted/40 p-3 space-y-1.5">
								<div className="flex items-center justify-between text-xs">
									<span className="text-muted-foreground">Per agent</span>
									<span className="font-mono">
										{rateLimit !== null ? `${rateLimit} ops/min` : "--"}
									</span>
								</div>
								<p className="text-[10px] text-muted-foreground/60">
									Override with <code className="bg-muted px-0.5 rounded">AGENT_RATE_LIMIT</code> env var.
								</p>
							</div>
						</section>
					</div>
				)}

				<div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 shrink-0">
					<Button
						size="sm"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button size="sm" onClick={handleSave} disabled={saving || loading} className="gap-1.5">
						{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
						Save
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
}
