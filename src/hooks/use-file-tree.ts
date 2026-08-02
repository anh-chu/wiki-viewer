"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isLite } from "@/lib/url-prefix";
import { withWs, wsFetch } from "@/lib/workspace-client";
import { useBacklinksStore } from "@/stores/backlinks-store";
import { prefetchPage } from "@/stores/editor-store";
import { showError, showSuccess } from "@/lib/toast";
import type { FileTreeNode } from "@/types/wiki";

export type TreeNode = FileTreeNode;

export type DirEntry = {
	name: string;
	type: "dir" | "file" | "app" | "node-app";
	size?: number;
	modifiedAt: string;
	git?: { branch: string; dirty: boolean };
};

// Max directories we ask the SSE watcher to cover. Mirrors the server's own cap;
// sending more would just be silently dropped there.
const WATCH_DIR_LIMIT = 24;

const dirPrefetchCache = new Map<string, TreeNode[]>();
const dirPrefetchInflight = new Map<string, Promise<TreeNode[]>>();

export async function fetchDir(dir: string): Promise<TreeNode[]> {
	const res = await wsFetch(`/api/wiki?dir=${encodeURIComponent(dir)}`);
	if (!res.ok) return [];
	const data: { entries: DirEntry[] } = await res.json();
	return data.entries.map((e) => ({
		name: e.name,
		path: dir ? `${dir}/${e.name}` : e.name,
		type: e.type,
		size: e.size,
		modifiedAt: e.modifiedAt,
		expanded: false,
		git: e.git,
	}));
}

export function prefetchDir(dir: string): void {
	if (dirPrefetchCache.has(dir) || dirPrefetchInflight.has(dir)) return;
	const promise = fetchDir(dir)
		.then((children) => {
			dirPrefetchCache.set(dir, children);
			return children;
		})
		.finally(() => dirPrefetchInflight.delete(dir));
	dirPrefetchInflight.set(dir, promise);
	promise.catch(() => {});
}

/** Consume a prefetched (or in-flight) dir listing, if any. One-shot. */
export async function takePrefetchedDir(
	dir: string,
): Promise<TreeNode[] | null> {
	const ready = dirPrefetchCache.get(dir);
	if (ready) {
		dirPrefetchCache.delete(dir);
		return ready;
	}
	const inflight = dirPrefetchInflight.get(dir);
	if (inflight) {
		const r = await inflight;
		dirPrefetchCache.delete(dir);
		return r;
	}
	return null;
}

export function updateNodes(
	nodes: TreeNode[],
	targetPath: string,
	updater: (n: TreeNode) => TreeNode,
): TreeNode[] {
	return nodes.map((n) => {
		if (n.path === targetPath) return updater(n);
		if (n.children)
			return { ...n, children: updateNodes(n.children, targetPath, updater) };
		return n;
	});
}

export function removeNode(nodes: TreeNode[], targetPath: string): TreeNode[] {
	return nodes
		.filter((n) => n.path !== targetPath)
		.map((n) =>
			n.children ? { ...n, children: removeNode(n.children, targetPath) } : n,
		);
}

export function collectExpandedPaths(nodes: TreeNode[]): string[] {
	const paths: string[] = [];
	for (const n of nodes) {
		if (
			(n.type === "dir" || n.type === "app" || n.type === "node-app") &&
			n.expanded &&
			n.children
		) {
			paths.push(n.path);
			paths.push(...collectExpandedPaths(n.children));
		}
	}
	return paths;
}

export interface UseFileTreeOptions {
	activeWorkspaceId: string | null;
	rootConfigured: boolean | null;
	onExternalChange?: (relPath: string) => void;
}

export type FileTreeApi = {
	roots: TreeNode[];
	rootLoaded: boolean;
	rootLoading: boolean;
	refreshingTree: boolean;
	refreshTree: () => Promise<void>;
	reloadDir: (dir: string) => Promise<void>;
	revealPath: (p: string) => Promise<void>;
	toggleFolder: (node: TreeNode) => Promise<void>;
	prefetch: (node: TreeNode) => void;
	nodeBranches: Record<string, { name: string; current: boolean }[]>;
	branchesLoading: Record<string, boolean>;
	checkingOutBranch: string | null;
	pullingRepo: string | null;
	branchDropdownNode: string | null;
	setBranchDropdownNode: (p: string | null) => void;
	branchDropdownPos: { top: number; left: number } | null;
	setBranchDropdownPos: (p: { top: number; left: number } | null) => void;
	loadBranches: (nodePath: string) => void;
	handleCheckout: (
		nodePath: string,
		branch: string,
		parentDir: string,
	) => Promise<void>;
	handleGitPull: (nodePath: string, parentDir: string) => Promise<void>;
};

export function useFileTree({
	activeWorkspaceId,
	rootConfigured,
	onExternalChange,
}: UseFileTreeOptions): FileTreeApi {
	const [roots, setRoots] = useState<TreeNode[]>([]);
	const [rootLoaded, setRootLoaded] = useState(false);
	const [rootLoading, setRootLoading] = useState(false);
	const rootLoadingRef = useRef(false);
	const [refreshingTree, setRefreshingTree] = useState(false);

	const [nodeBranches, setNodeBranches] = useState<
		Record<string, { name: string; current: boolean }[]>
	>({});
	const [branchesLoading, setBranchesLoading] = useState<
		Record<string, boolean>
	>({});
	const [checkingOutBranch, setCheckingOutBranch] = useState<string | null>(
		null,
	);
	const [pullingRepo, setPullingRepo] = useState<string | null>(null);
	const [branchDropdownNode, setBranchDropdownNode] = useState<string | null>(
		null,
	);
	const [branchDropdownPos, setBranchDropdownPos] = useState<{
		top: number;
		left: number;
	} | null>(null);

	// Reset tree state when the active workspace changes.
	useEffect(() => {
		setRoots([]);
		setRootLoaded(false);
		rootLoadingRef.current = false;
		setNodeBranches({});
		setBranchesLoading({});
		setCheckingOutBranch(null);
		setPullingRepo(null);
		setBranchDropdownNode(null);
		setBranchDropdownPos(null);
	}, [activeWorkspaceId]);

	// Load roots once the workspace is resolved.
	useEffect(() => {
		if (!activeWorkspaceId) return;
		if (rootLoaded || rootLoadingRef.current) return;
		rootLoadingRef.current = true;
		setRootLoading(true);
		fetchDir("")
			.then((nodes) => {
				setRoots(nodes);
				setRootLoaded(true);
				setRootLoading(false);
			})
			.catch(() => {
				rootLoadingRef.current = false;
				setRootLoading(false);
			});
	}, [rootLoaded, activeWorkspaceId]);

	const reloadDir = useCallback(async (dir: string) => {
		const fresh = await fetchDir(dir);
		if (dir === "") {
			setRoots((prev) => {
				const prevByPath = new Map(prev.map((n) => [n.path, n]));
				return fresh.map((n) => {
					const old = prevByPath.get(n.path);
					if (old && (old.type === "dir" || old.type === "app")) {
						return { ...n, expanded: old.expanded, children: old.children };
					}
					return n;
				});
			});
		} else {
			setRoots((prev) =>
				updateNodes(prev, dir, (n) => ({
					...n,
					children: fresh,
					expanded: true,
				})),
			);
		}
	}, []);

	const revealPath = useCallback(async (p: string) => {
		const parts = p.split("/");
		if (parts.length <= 1) return;
		const levels: { prefix: string; children: TreeNode[] }[] = [];
		let prefix = "";
		for (let i = 0; i < parts.length - 1; i++) {
			prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
			levels.push({ prefix, children: await fetchDir(prefix) });
		}
		setRoots((prev) => {
			let next = prev;
			for (const { prefix: pfx, children } of levels) {
				next = updateNodes(next, pfx, (n) => ({
					...n,
					children,
					expanded: true,
				}));
			}
			return next;
		});
	}, []);

	const refreshTree = useCallback(async () => {
		setRefreshingTree(true);
		try {
			const expandedPaths = collectExpandedPaths(roots);
			const fresh = await fetchDir("");
			setRoots(fresh);
			for (const p of expandedPaths) {
				const dirFresh = await fetchDir(p);
				setRoots((prev) =>
					updateNodes(prev, p, (n) => ({
						...n,
						children: dirFresh,
						expanded: true,
					})),
				);
			}
		} finally {
			setRefreshingTree(false);
		}
	}, [roots]);

	const toggleFolder = useCallback(async (node: TreeNode) => {
		if (
			node.type !== "dir" &&
			node.type !== "app" &&
			node.type !== "node-app"
		)
			return;
		if (!node.expanded) {
			if (node.children === undefined) {
				const prefetched = await takePrefetchedDir(node.path);
				if (prefetched) {
					setRoots((prev) =>
						updateNodes(prev, node.path, (n) => ({
							...n,
							loading: false,
							children: prefetched,
							expanded: true,
						})),
					);
					return;
				}
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({ ...n, loading: true })),
				);
				const children = await fetchDir(node.path);
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({
						...n,
						loading: false,
						children,
						expanded: true,
					})),
				);
			} else {
				setRoots((prev) =>
					updateNodes(prev, node.path, (n) => ({ ...n, expanded: true })),
				);
			}
		} else {
			setRoots((prev) =>
				updateNodes(prev, node.path, (n) => ({ ...n, expanded: false })),
			);
		}
	}, []);

	const prefetch = useCallback((node: TreeNode) => {
		if (node.type === "file") {
			if (node.name.endsWith(".md") || node.name.endsWith(".markdown"))
				prefetchPage(node.path);
		} else {
			prefetchDir(node.path);
		}
	}, []);

	const expandedDirsRef = useRef<string[]>([]);
	useEffect(() => {
		expandedDirsRef.current = collectExpandedPaths(roots);
	}, [roots]);

	const watchDirsKey = useMemo(
		() =>
			collectExpandedPaths(roots)
				.filter((d) => d !== "")
				.slice(0, WATCH_DIR_LIMIT)
				.join("\n"),
		[roots],
	);
	const [watchDirs, setWatchDirs] = useState("");
	useEffect(() => {
		const id = setTimeout(() => setWatchDirs(watchDirsKey), 300);
		return () => clearTimeout(id);
	}, [watchDirsKey]);

	const onExternalChangeRef = useRef(onExternalChange);
	useEffect(() => {
		onExternalChangeRef.current = onExternalChange;
	}, [onExternalChange]);

	useEffect(() => {
		if (!rootConfigured) return;
		if (isLite()) return;
		if (!activeWorkspaceId) return;

		const pendingReloads = new Map<string, ReturnType<typeof setTimeout>>();

		function scheduleReload(dir: string) {
			if (pendingReloads.has(dir)) clearTimeout(pendingReloads.get(dir)!);
			pendingReloads.set(
				dir,
				setTimeout(() => {
					pendingReloads.delete(dir);
					void reloadDir(dir);
				}, 300),
			);
		}

		const dirs = watchDirs ? watchDirs.split("\n") : [];
		const qs = dirs.map((d) => `dir=${encodeURIComponent(d)}`).join("&");
		const es = new EventSource(
			withWs(qs ? `/api/wiki/watch?${qs}` : "/api/wiki/watch"),
		);

		es.onmessage = (event) => {
			let data: { type: string; path: string };
			try {
				data = JSON.parse(event.data as string) as {
					type: string;
					path: string;
				};
			} catch {
				return;
			}
			const { type, path: relPath } = data;

			if (type === "rescan") {
				useBacklinksStore.getState().invalidateAll();
				scheduleReload("");
				for (const dir of expandedDirsRef.current) scheduleReload(dir);
				return;
			}

			if (type === "add" || type === "change" || type === "unlink") {
				useBacklinksStore.getState().invalidateAll();
			}

			const parts = relPath.split("/");
			const parentDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
			scheduleReload(parentDir);

			if (type === "change") {
				const key = `__file__${relPath}`;
				if (pendingReloads.has(key)) clearTimeout(pendingReloads.get(key)!);
				pendingReloads.set(
					key,
					setTimeout(() => {
						pendingReloads.delete(key);
						onExternalChangeRef.current?.(relPath);
					}, 400),
				);
			}
		};

		return () => {
			es.close();
			for (const t of pendingReloads.values()) clearTimeout(t);
		};
	}, [rootConfigured, reloadDir, activeWorkspaceId, watchDirs]);

	const loadBranches = useCallback(async (nodePath: string) => {
		if (nodeBranches[nodePath] || branchesLoading[nodePath]) return;
		let cancelled = false;
		setBranchesLoading((prev) => ({ ...prev, [nodePath]: true }));
		try {
			const res = await wsFetch(
				`/api/wiki/git-branches?path=${encodeURIComponent(nodePath)}`,
			);
			if (cancelled) return;
			if (!res.ok) {
				showError("Could not load branches");
				return;
			}
			const d: { branches: { name: string; current: boolean }[] } =
				await res.json();
			if (!cancelled)
				setNodeBranches((prev) => ({ ...prev, [nodePath]: d.branches }));
		} catch {
			if (!cancelled) showError("Could not load branches");
		} finally {
			if (!cancelled)
				setBranchesLoading((prev) => ({ ...prev, [nodePath]: false }));
		}
	}, [nodeBranches, branchesLoading]);

	const handleCheckout = useCallback(
		async (nodePath: string, branch: string, parentDir: string) => {
			if (checkingOutBranch) return;
			setCheckingOutBranch(branch);
			try {
				const res = await wsFetch("/api/wiki/git-checkout", {
					method: "POST",
					body: JSON.stringify({ path: nodePath, branch }),
				});
				if (res.status === 409) {
					showError("Repository has uncommitted changes");
					return;
				}
				if (!res.ok) {
					const e: { error?: string } = await res.json();
					showError(e.error ?? "Checkout failed");
					return;
				}
				const d: { branch: string; sha: string } = await res.json();
				showSuccess(`Switched to ${d.branch}`);
				setBranchDropdownNode(null);
				setBranchDropdownPos(null);
				setNodeBranches((prev) => {
					const n = { ...prev };
					delete n[nodePath];
					return n;
				});
				await reloadDir(parentDir);
			} catch {
				showError("Checkout failed");
			} finally {
				setCheckingOutBranch(null);
			}
		},
		[checkingOutBranch, reloadDir],
	);

	const handleGitPull = useCallback(
		async (nodePath: string, parentDir: string) => {
			if (pullingRepo) return;
			setPullingRepo(nodePath);
			try {
				const res = await wsFetch("/api/wiki/git-pull", {
					method: "POST",
					body: JSON.stringify({ path: nodePath }),
				});
				if (!res.ok) {
					const e: { error?: string; message?: string } = await res.json();
					showError(e.message ?? e.error ?? "Pull failed");
					return;
				}
				const data: { branch: string; sha: string } = await res.json();
				showSuccess(`Pulled ${nodePath} (${data.branch} @ ${data.sha.slice(0, 7)})`);
				await reloadDir(parentDir);
			} catch {
				showError("Pull failed");
			} finally {
				setPullingRepo(null);
			}
		},
		[pullingRepo, reloadDir],
	);

	return {
		roots,
		rootLoaded,
		rootLoading,
		refreshingTree,
		refreshTree,
		reloadDir,
		revealPath,
		toggleFolder,
		prefetch,
		nodeBranches,
		branchesLoading,
		checkingOutBranch,
		pullingRepo,
		branchDropdownNode,
		setBranchDropdownNode,
		branchDropdownPos,
		setBranchDropdownPos,
		loadBranches,
		handleCheckout,
		handleGitPull,
	};
}
