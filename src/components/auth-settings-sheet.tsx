"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { showError } from "@/lib/toast";

interface AuthSettings {
	allowedEmails: string[];
	allowedDomains: string[];
	source: "config" | "env";
	envFallbackActive: boolean;
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
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to load");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

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
			<SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
				<SheetHeader>
					<SheetTitle>Signup allowlist</SheetTitle>
					<SheetDescription>
						Control who can create an account. Leave both lists empty to allow
						any email. Saving here overrides the AUTH_ALLOWED_EMAILS and
						AUTH_ALLOWED_DOMAIN environment variables.
					</SheetDescription>
				</SheetHeader>

				{loading ? (
					<div className="flex flex-1 items-center justify-center">
						<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="flex-1 space-y-5 overflow-auto py-4">
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
					</div>
				)}

				<SheetFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={saving || loading} className="gap-1.5">
						{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
						Save
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
