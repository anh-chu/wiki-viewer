"use client";

import { ChevronRight, Folder, Home, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchDir } from "@/hooks/use-file-tree";
import { cn } from "@/lib/utils";

interface SaveScratchDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Suggested filename (with extension). */
	defaultName: string;
	/** Called with the chosen workspace-relative destination path. */
	onSave: (destPath: string) => void;
}

export function SaveScratchDialog({
	open,
	onOpenChange,
	defaultName,
	onSave,
}: SaveScratchDialogProps) {
	const [dir, setDir] = useState("");
	const [folders, setFolders] = useState<Array<{ name: string; path: string }>>(
		[],
	);
	const [loading, setLoading] = useState(false);
	const [name, setName] = useState(defaultName);

	const load = useCallback(async (target: string) => {
		setLoading(true);
		try {
			const entries = await fetchDir(target);
			setFolders(
				entries
					.filter((e) => e.type === "dir")
					.map((e) => ({ name: e.name, path: e.path })),
			);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		setName(defaultName);
		setDir("");
		void load("");
	}, [open, defaultName, load]);

	const go = useCallback(
		(target: string) => {
			setDir(target);
			void load(target);
		},
		[load],
	);

	const crumbs = dir ? dir.split("/") : [];
	const trimmedName = name.trim();
	const destPath = dir ? `${dir}/${trimmedName}` : trimmedName;
	const canSave = trimmedName.length > 0 && !trimmedName.endsWith("/");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Save scratch to file</DialogTitle>
				</DialogHeader>

				<div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
					<button
						type="button"
						className="inline-flex items-center gap-1 hover:text-foreground"
						onClick={() => go("")}
					>
						<Home className="h-3.5 w-3.5" />
						root
					</button>
					{crumbs.map((seg, i) => {
						const p = crumbs.slice(0, i + 1).join("/");
						return (
							<span key={p} className="inline-flex items-center gap-1">
								<ChevronRight className="h-3 w-3" />
								<button
									type="button"
									className="hover:text-foreground"
									onClick={() => go(p)}
								>
									{seg}
								</button>
							</span>
						);
					})}
				</div>

				<div className="h-56 overflow-auto rounded-md border">
					{loading ? (
						<div className="flex justify-center py-6">
							<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
						</div>
					) : folders.length === 0 ? (
						<p className="px-3 py-4 text-xs text-muted-foreground">
							No subfolders here.
						</p>
					) : (
						folders.map((f) => (
							<button
								type="button"
								key={f.path}
								className={cn(
									"flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted",
								)}
								onClick={() => go(f.path)}
							>
								<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
								<span className="truncate">{f.name}</span>
							</button>
						))
					)}
				</div>

				<div className="flex flex-col gap-1">
					<label className="text-xs text-muted-foreground" htmlFor="scratch-name">
						File name
					</label>
					<Input
						id="scratch-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && canSave) onSave(destPath);
						}}
					/>
					<p className="text-[11px] text-muted-foreground truncate">
						Saves to: {destPath || "(enter a name)"}
					</p>
				</div>

				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled={!canSave} onClick={() => onSave(destPath)}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
