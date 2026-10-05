"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, Loader2 } from "lucide-react";
import { apiUrl } from "@/lib/url-prefix";
import { cn } from "@/lib/utils";

export interface ShareEntry {
	name: string;
	/** Path relative to the share root. */
	path: string;
	isDir: boolean;
	size: number;
}

interface ShareTreeProps {
	token: string;
	/** Name of the share root, shown as the tree's heading. */
	rootName: string;
	/** Path of what the reader is showing: a file path, or a folder path. */
	currentPath: string;
	/** True when the reader is showing a folder's index rather than a file. */
	currentIsDir: boolean;
	/**
	 * A listing the page already loaded. Adopting it avoids a second request for
	 * the same folder, which would also count as a second view.
	 */
	seed?: { path: string; entries: ShareEntry[] };
	onNavigate: (path: string) => void;
}

/**
 * Folder tree for a public folder share.
 *
 * Listings are fetched one folder at a time and kept in a ref: the cache must be
 * readable inside the load guard without re-creating it on every render, and a
 * strict-mode double effect must not fetch the same folder twice.
 */
export function ShareTree({
	token,
	rootName,
	currentPath,
	currentIsDir,
	seed,
	onNavigate,
}: ShareTreeProps) {
	const cacheRef = useRef(new Map<string, ShareEntry[]>());
	const inFlightRef = useRef(new Set<string>());
	const [, setVersion] = useState(0);
	const [blocked, setBlocked] = useState(false);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
	const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());

	// Adopt the listing the reader already has. No request, no extra view.
	useEffect(() => {
		if (!seed) return;
		if (cacheRef.current.has(seed.path)) return;
		cacheRef.current.set(seed.path, seed.entries);
		setVersion((v) => v + 1);
	}, [seed]);

	const load = useCallback(
		async (folder: string) => {
			if (cacheRef.current.has(folder) || inFlightRef.current.has(folder)) return;
			inFlightRef.current.add(folder);
			setLoadingFolders((prev) => new Set(prev).add(folder));
			try {
				const query = folder ? `?path=${encodeURIComponent(folder)}` : "";
				const res = await fetch(apiUrl(`/api/share/${token}${query}`));
				if (res.status === 401) {
					// A protected share that is not unlocked. Hide navigation
					// instead of retrying on every render.
					setBlocked(true);
					return;
				}
				if (!res.ok) return;
				const data = (await res.json()) as { entries?: ShareEntry[] };
				cacheRef.current.set(folder, Array.isArray(data.entries) ? data.entries : []);
				setVersion((v) => v + 1);
			} catch {
				// Offline: leave the folder closed. The next click retries.
			} finally {
				inFlightRef.current.delete(folder);
				setLoadingFolders((prev) => {
					const next = new Set(prev);
					next.delete(folder);
					return next;
				});
			}
		},
		[token],
	);

	/** Folders that must be open for the current path to be visible. */
	const visibleFolders = useMemo(() => {
		const folders = [""];
		if (currentPath) {
			const parts = currentPath.split("/").filter(Boolean);
			const ancestors = currentIsDir ? parts : parts.slice(0, -1);
			for (let i = 0; i < ancestors.length; i++) {
				folders.push(ancestors.slice(0, i + 1).join("/"));
			}
		}
		return folders;
	}, [currentPath, currentIsDir]);

	useEffect(() => {
		if (blocked) return;
		setExpanded((prev) => {
			if (visibleFolders.every((folder) => prev.has(folder))) return prev;
			const next = new Set(prev);
			for (const folder of visibleFolders) next.add(folder);
			return next;
		});
		for (const folder of visibleFolders) {
			if (!cacheRef.current.has(folder)) void load(folder);
		}
	}, [visibleFolders, blocked, load]);

	const collapse = (path: string) => {
		setExpanded((prev) => {
			if (!prev.has(path)) return prev;
			const next = new Set(prev);
			next.delete(path);
			return next;
		});
	};

	const openFolder = (path: string) => {
		setExpanded((prev) => new Set(prev).add(path));
		if (!cacheRef.current.has(path)) void load(path);
		onNavigate(path);
	};

	if (blocked) return null;

	const renderLevel = (folder: string) => {
		const entries = cacheRef.current.get(folder) ?? [];
		return (
			<ul className="space-y-0.5">
				{entries.map((entry) => {
					const isOpen = expanded.has(entry.path);
					const isCurrent = entry.isDir
						? currentIsDir && entry.path === currentPath
						: entry.path === currentPath;
					if (entry.isDir) {
						return (
							<li key={entry.path}>
								<button
									type="button"
									aria-expanded={isOpen}
									aria-current={isCurrent ? "page" : undefined}
									onClick={() => (isOpen ? collapse(entry.path) : openFolder(entry.path))}
									className={cn(
										"flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										isCurrent && "bg-accent font-medium",
									)}
								>
									<ChevronRight
										className={cn(
											"h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
											isOpen && "rotate-90",
										)}
									/>
									<Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate" title={entry.name}>
										{entry.name}
									</span>
									{loadingFolders.has(entry.path) && (
										<Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
									)}
								</button>
								{isOpen && (
									<div className="ml-3 border-l border-border pl-1">
										{renderLevel(entry.path)}
									</div>
								)}
							</li>
						);
					}
					return (
						<li key={entry.path}>
							<button
								type="button"
								aria-current={isCurrent ? "page" : undefined}
								onClick={() => onNavigate(entry.path)}
								className={cn(
									"flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									isCurrent && "bg-accent font-medium",
								)}
							>
								<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate" title={entry.name}>
									{entry.name}
								</span>
							</button>
						</li>
					);
				})}
				{entries.length === 0 && !loadingFolders.has(folder) && (
					<li className="px-2 py-1 text-xs text-muted-foreground">Empty folder</li>
				)}
			</ul>
		);
	};

	return (
		<div className="text-sm">
			<div className="mb-1 flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
				<Folder className="h-3.5 w-3.5 shrink-0" />
				<span className="min-w-0 truncate" title={rootName}>
					{rootName}
				</span>
			</div>
			{renderLevel("")}
		</div>
	);
}
