"use client";

import type React from "react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DialogContent,
	DialogFooter,
	DialogHeader,
	Dialog as DialogRoot,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showError } from "@/lib/toast";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";

type Dir = "entities" | "concepts" | "comparisons";

export interface WikiCreateResult {
	ok: boolean;
	slug: string;
	dir?: Dir;
}

interface DialogState {
	slug: string;
	dir: Dir;
	title: string;
}

function humanizeSlug(slug: string): string {
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

const DIRS: Dir[] = ["entities", "concepts", "comparisons"];

export function useWikiLinkCreate(): {
	open: (slug: string) => Promise<WikiCreateResult>;
	Dialog: React.ReactNode;
} {
	const [isOpen, setIsOpen] = useState(false);
	const [dialogState, setDialogState] = useState<DialogState>({
		slug: "",
		dir: "entities",
		title: "",
	});
	const [isSubmitting, setIsSubmitting] = useState(false);
	const resolveRef = useRef<((result: WikiCreateResult) => void) | null>(null);

	const open = useCallback((slug: string): Promise<WikiCreateResult> => {
		setDialogState({
			slug,
			dir: "entities",
			title: humanizeSlug(slug),
		});
		setIsOpen(true);
		return new Promise<WikiCreateResult>((resolve) => {
			resolveRef.current = resolve;
		});
	}, []);

	const handleCancel = useCallback(() => {
		setIsOpen(false);
		resolveRef.current?.({ ok: false, slug: dialogState.slug });
		resolveRef.current = null;
	}, [dialogState.slug]);

	const handleCreate = useCallback(async () => {
		const { slug, dir, title } = dialogState;
		setIsSubmitting(true);
		try {
			const res = await fetch("/api/wiki/page", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					slug,
					dir,
					title: title.trim() || undefined,
				}),
			});

			if (res.ok || res.status === 409) {
				// 409 means the page already exists — still a success from our POV
				const store = useWikiSlugsStore.getState();
				store.invalidate();
				void store.load();
				setIsOpen(false);
				resolveRef.current?.({ ok: true, slug, dir });
				resolveRef.current = null;
			} else {
				const data: unknown = await res.json().catch(() => ({}));
				const msg =
					data !== null &&
					typeof data === "object" &&
					"error" in data &&
					typeof (data as { error: unknown }).error === "string"
						? (data as { error: string }).error
						: "Failed to create page";
				showError(msg);
			}
		} catch {
			showError("Failed to create page");
		} finally {
			setIsSubmitting(false);
		}
	}, [dialogState]);

	const dialogNode = (
		<DialogRoot
			open={isOpen}
			onOpenChange={(v) => {
				if (!v) handleCancel();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create wiki page</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="space-y-1.5">
						<Label htmlFor="wiki-create-slug">Slug</Label>
						<Input
							id="wiki-create-slug"
							value={dialogState.slug}
							readOnly
							className="bg-muted cursor-default select-all"
						/>
					</div>

					<div className="space-y-1.5">
						<Label>Directory</Label>
						<div className="flex gap-4">
							{DIRS.map((d) => (
								<label
									key={d}
									className="flex items-center gap-1.5 text-sm cursor-pointer"
								>
									<input
										type="radio"
										name="wiki-create-dir"
										value={d}
										checked={dialogState.dir === d}
										onChange={() => setDialogState((s) => ({ ...s, dir: d }))}
										className="accent-primary"
									/>
									{d}
								</label>
							))}
						</div>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="wiki-create-title">Title (optional)</Label>
						<Input
							id="wiki-create-title"
							value={dialogState.title}
							onChange={(e) =>
								setDialogState((s) => ({ ...s, title: e.target.value }))
							}
							placeholder="Humanized title..."
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={handleCancel}
						disabled={isSubmitting}
					>
						Cancel
					</Button>
					<Button onClick={() => void handleCreate()} disabled={isSubmitting}>
						{isSubmitting ? "Creating..." : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</DialogRoot>
	);

	return { open, Dialog: dialogNode };
}
