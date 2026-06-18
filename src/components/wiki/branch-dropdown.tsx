"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BranchItem {
	name: string;
	current: boolean;
}

/**
 * Floating branch picker rendered into document.body so it escapes any
 * overflow-hidden / menu container. Shared by the file-tree sub-repo switcher
 * and the workspace switcher. The portal root carries `data-branch-portal` so
 * callers inside a Radix menu can keep that menu open on interact-outside.
 */
export function BranchDropdown({
	pos,
	branches,
	loading,
	busyName,
	disabled,
	onPick,
	onClose,
}: {
	pos: { top: number; left: number };
	branches: BranchItem[];
	loading: boolean;
	busyName: string | null;
	disabled: boolean;
	onPick: (name: string) => void;
	onClose: () => void;
}) {
	const [filter, setFilter] = useState("");
	const rootRef = useRef<HTMLDivElement>(null);

	// Self-contained outside-click + Escape close. The portal mounts on
	// document.body, outside the React subtree, so click events don't bubble to
	// any parent handler. Ignore clicks on the trigger so it can still toggle.
	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (rootRef.current?.contains(t) || t?.closest?.("[data-branch-trigger]")) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	if (typeof document === "undefined") return null;

	const showFilter = branches.length > 8;
	const q = filter.trim().toLowerCase();
	const shown = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;

	return createPortal(
		<div
			ref={rootRef}
			data-branch-portal
			style={{ position: "fixed", top: pos.top, left: pos.left }}
			className="pointer-events-auto z-[9999] flex max-h-72 w-52 flex-col overflow-hidden rounded-md border bg-popover p-1 shadow-md"
		>
			{loading ? (
				<div className="flex justify-center py-2">
					<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
				</div>
			) : branches.length === 0 ? (
				<p className="px-2 py-1 text-[10px] text-muted-foreground">No branches</p>
			) : (
				<>
					{showFilter && (
						<input
							autoFocus
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter branches…"
							className="mb-1 w-full shrink-0 rounded border bg-background px-1.5 py-1 text-[11px] outline-none focus:ring-1 focus:ring-ring"
						/>
					)}
					<div className="min-h-0 flex-1 overflow-auto">
						{shown.length === 0 ? (
							<p className="px-2 py-1 text-[10px] text-muted-foreground">No match</p>
						) : (
							shown.map((b) => (
								<button
									key={b.name}
									type="button"
									disabled={disabled || b.current}
									className={cn(
										"flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] hover:bg-muted",
										b.current ? "font-semibold text-foreground" : "text-muted-foreground",
									)}
									onClick={(e) => { e.stopPropagation(); if (!b.current) onPick(b.name); }}
								>
									{b.current ? <Check className="h-3 w-3 shrink-0" /> : <span className="w-3 shrink-0" />}
									<span className="truncate">{b.name}</span>
									{busyName === b.name && <Loader2 className="ml-auto h-3 w-3 shrink-0 animate-spin" />}
								</button>
							))
						)}
					</div>
				</>
			)}
		</div>,
		document.body,
	);
}
