"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { wsFetch } from "@/lib/workspace-client";
import { useHostedAppsStore } from "@/stores/hosted-apps-store";

// Client-side mirrors of the server validation (src/lib/hosted-apps.ts). The
// server remains authoritative; these give immediate inline feedback.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED_SLUGS = new Set(["api", "app", "s", "signin", "_next", "assets"]);

function validate(slug: string, existing: Set<string>): string | null {
	const s = slug.trim();
	if (!s) return "Slug is required";
	if (!SLUG_REGEX.test(s))
		return "Lowercase letters, numbers, and hyphens only (e.g. my-app)";
	if (RESERVED_SLUGS.has(s)) return `"${s}" is a reserved name`;
	if (existing.has(s)) return `"${s}" is already taken`;
	return null;
}

export function HostAppDialog() {
	const dialog = useHostedAppsStore((s) => s.dialog);
	const apps = useHostedAppsStore((s) => s.apps);
	const create = useHostedAppsStore((s) => s.create);
	const refresh = useHostedAppsStore((s) => s.refresh);
	const closeHostDialog = useHostedAppsStore((s) => s.closeHostDialog);

	const [slug, setSlug] = useState("");
	const [script, setScript] = useState("");
	const [scripts, setScripts] = useState<string[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [serverError, setServerError] = useState<string | null>(null);

	// Ensure the known-slug set is fresh for uniqueness hints when opening.
	useEffect(() => {
		if (!dialog) return;
		setSlug(dialog.defaultSlug);
		setScript("");
		setScripts([]);
		setServerError(null);
		void refresh();
		if (dialog.type === "node") {
			void wsFetch(`/api/wiki/app?path=${encodeURIComponent(dialog.relPath)}`)
				.then(async (res) => {
					if (!res.ok) return;
					const data = (await res.json()) as {
						scripts?: string[];
						defaultScript?: string | null;
					};
					const available = data.scripts ?? [];
					setScripts(available);
					setScript(data.defaultScript ?? available[0] ?? "");
				})
				.catch(() => {});
		}
	}, [dialog, refresh]);

	if (!dialog) return null;

	const existing = new Set(apps.map((a) => a.slug));
	const inlineError = validate(slug, existing);
	const disabled = submitting || inlineError !== null;

	const submit = async () => {
		if (inlineError) return;
		setSubmitting(true);
		setServerError(null);
		const result = await create({
			slug: slug.trim(),
			relPath: dialog.relPath,
			type: dialog.type ?? "html",
			script: dialog.type === "node" && script ? script : undefined,
		});
		setSubmitting(false);
		if (result.ok) {
			closeHostDialog();
		} else {
			setServerError(result.message ?? result.error ?? "Failed to host app");
		}
	};

	return (
		<Dialog open={!!dialog} onOpenChange={(open) => !open && closeHostDialog()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Host this app</DialogTitle>
					<DialogDescription>
						Give this directory a short slug. It will be reachable at{" "}
						<code className="text-xs">/app/{slug || "<slug>"}/</code>.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-2 py-2">
					<Label htmlFor="host-slug">Slug</Label>
					<Input
						id="host-slug"
						autoFocus
						value={slug}
						onChange={(e) => {
							setSlug(e.target.value);
							setServerError(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !disabled) void submit();
						}}
						placeholder="my-app"
						aria-invalid={!!(inlineError || serverError)}
					/>
					{dialog.type === "node" && scripts.length > 0 && (
						<div className="space-y-2">
							<Label htmlFor="host-script">Start script</Label>
							<select
								id="host-script"
								className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
								value={script}
							onChange={(e) => setScript(e.target.value)}
							>
								{scripts.map((name) => (
									<option key={name} value={name}>{name}</option>
								))}
							</select>
						</div>
					)}
					<p className="min-h-[1rem] text-xs text-muted-foreground">
						<span className="truncate">{dialog.relPath || "(workspace root)"}</span>
					</p>
					{(inlineError || serverError) && (
						<p className="text-xs text-destructive">
							{serverError ?? inlineError}
						</p>
					)}
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={closeHostDialog} disabled={submitting}>
						Cancel
					</Button>
					<Button onClick={() => void submit()} disabled={disabled}>
						{submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
						Host
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
