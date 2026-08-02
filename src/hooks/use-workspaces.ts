"use client";

import { useCallback, useEffect, useState } from "react";

import { apiUrl } from "@/lib/url-prefix";
import {
	getActiveWorkspaceId,
	getEphemeralRoot,
} from "@/lib/workspace-client";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";
import { useBacklinksStore } from "@/stores/backlinks-store";
import { showError, showSuccess } from "@/lib/toast";

export interface WorkspaceGit {
	remoteUrl: string;
	branch?: string;
	username?: string;
	lastPulledAt?: string;
	lastSha?: string;
	lastError?: string;
}

export interface WorkspaceSsh {
	host: string;
}

export interface WorkspaceSummary {
	id: string;
	name: string;
	rootDir: string;
	lastOpenedAt?: string;
	createdAt: string;
	readOnly?: boolean;
	git?: WorkspaceGit;
	ssh?: WorkspaceSsh;
}

/** Invalidate cross-workspace client caches when the active workspace changes. */
export function resetWorkspaceClientState() {
	useWikiSlugsStore.getState().invalidate();
	useBacklinksStore.getState().invalidateAll();
}

export function useWorkspaces() {
	const [rootConfigured, setRootConfigured] = useState<boolean | null>(null);
	const [rootPath, setRootPath] = useState<string | null>(null);
	const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
		() => (typeof window !== "undefined" ? getActiveWorkspaceId() : null),
	);
	const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
	const [isWsAdmin, setIsWsAdmin] = useState(false);
	const [addingWorkspace, setAddingWorkspace] = useState(false);
	const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(
		null,
	);
	const [refreshingWsId, setRefreshingWsId] = useState<string | null>(null);
	const [wsBranches, setWsBranches] = useState<Record<string, string[]>>({});
	const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
	const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(
		null,
	);
	const [branchPickerWsId, setBranchPickerWsId] = useState<string | null>(null);
	const [wsBranchPos, setWsBranchPos] = useState<{
		top: number;
		left: number;
	} | null>(null);

	const loadWorkspaces = useCallback(async () => {
		const ephRoot = getEphemeralRoot();
		if (ephRoot) {
			setWorkspaces([]);
			setIsWsAdmin(false);
			setRootConfigured(true);
			setRootPath(ephRoot);
			setActiveWorkspaceId(`root:${ephRoot}`);
				return;
		}
		try {
			const res = await fetch(apiUrl("/api/system/workspaces"));
			if (!res.ok) throw new Error("Failed");
			const d: {
				workspaces: WorkspaceSummary[];
				isAdmin: boolean;
			} = await res.json();
			setWorkspaces(d.workspaces);
			setIsWsAdmin(d.isAdmin);
			if (d.workspaces.length > 0) {
				setRootConfigured(true);
				const urlWsId = new URLSearchParams(window.location.search).get("ws");
				const inList = urlWsId
					? d.workspaces.find((w) => w.id === urlWsId)
					: null;
				const active =
					inList ??
					[...d.workspaces].sort((a, b) =>
						(b.lastOpenedAt ?? b.createdAt).localeCompare(
							a.lastOpenedAt ?? a.createdAt,
						),
					)[0];
				setActiveWorkspaceId(active.id);
				setRootPath(active.rootDir);
				if (!inList) {
					const u = new URL(location.href);
					u.searchParams.set("ws", active.id);
					history.replaceState(null, "", u.toString());
				}
			} else {
				setRootConfigured(false);
			}
		} catch {
			setRootConfigured(false);
		}
	}, []);

	useEffect(() => {
		void loadWorkspaces();
	}, [loadWorkspaces]);

	const switchWorkspace = useCallback(
		async (id: string) => {
			if (id === activeWorkspaceId) return;
			try {
				await fetch(apiUrl(`/api/system/workspaces/${id}/open`), {
					method: "POST",
				});
			} catch {
				/* best-effort lastOpened bump */
			}
			const u = new URL(location.href);
			u.searchParams.set("ws", id);
			u.searchParams.delete("path");
			history.pushState(null, "", u.toString());
			resetWorkspaceClientState();
			const ws = workspaces.find((w) => w.id === id);
			if (ws) setRootPath(ws.rootDir);
			setActiveWorkspaceId(id);
		},
		[activeWorkspaceId, workspaces],
	);

	const handleDeleteWorkspace = useCallback(
		async (onSwitch: (nextId: string) => Promise<void>) => {
			if (!deletingWorkspaceId) return;
			try {
				const res = await fetch(
					apiUrl(`/api/system/workspaces/${deletingWorkspaceId}`),
					{ method: "DELETE" },
				);
				if (!res.ok) throw new Error("Failed");
				if (deletingWorkspaceId === activeWorkspaceId) {
					const remaining = workspaces.filter(
						(w) => w.id !== deletingWorkspaceId,
					);
					if (remaining.length > 0) {
						const next = [...remaining].sort((a, b) =>
							(b.lastOpenedAt ?? b.createdAt).localeCompare(
								a.lastOpenedAt ?? a.createdAt,
							),
						)[0];
						await onSwitch(next.id);
					} else {
						setRootConfigured(false);
					}
				}
				await loadWorkspaces();
			} catch {
				/* ignore */
			} finally {
				setDeletingWorkspaceId(null);
			}
		},
		[deletingWorkspaceId, activeWorkspaceId, workspaces, loadWorkspaces],
	);

	const handleRefreshWorkspace = useCallback(
		async (id: string) => {
			if (refreshingWsId) return;
			setRefreshingWsId(id);
			try {
				const res = await fetch(
					apiUrl(`/api/system/workspaces/${id}/refresh`),
					{ method: "POST" },
				);
				if (!res.ok) {
					const e: { error?: string } = await res.json();
					
					showError(e.error ?? "Refresh failed");
				return;
				}
				await loadWorkspaces();
			} catch {
				showError("Refresh failed");
			} finally {
				setRefreshingWsId(null);
			}
		},
		[refreshingWsId, loadWorkspaces],
	);

	const loadWsBranches = useCallback(
		async (id: string) => {
			if (wsBranches[id]) return;
			try {
				const res = await fetch(apiUrl(`/api/system/workspaces/${id}/branch`));
				if (!res.ok) return;
				const d: { branches?: string[] } = await res.json();
				setWsBranches((prev) => ({ ...prev, [id]: d.branches ?? [] }));
			} catch {
				/* ignore */
			}
		},
		[wsBranches],
	);

	const handleSwitchBranch = useCallback(
		async (id: string, branch: string) => {
			if (switchingBranch) return;
			setSwitchingBranch(id);
			setSwitchingBranchName(branch);
			try {
				const res = await fetch(apiUrl(`/api/system/workspaces/${id}/branch`), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ branch }),
				});
				if (!res.ok) {
					const e: { error?: string } = await res.json();
					showError(e.error ?? "Branch switch failed");
				return;
				}
				showSuccess(`Switched to ${branch}`);
				setBranchPickerWsId(null);
				setWsBranchPos(null);
				await loadWorkspaces();
			} catch {
				showError("Branch switch failed");
			} finally {
				setSwitchingBranch(null);
				setSwitchingBranchName(null);
			}
		},
		[switchingBranch, loadWorkspaces],
	);

	return {
		rootConfigured,
		rootPath,
		activeWorkspaceId,
		workspaces,
		isWsAdmin,
		addingWorkspace,
		setAddingWorkspace,
		setRootConfigured,
		setActiveWorkspaceId,
		deletingWorkspaceId,
		setDeletingWorkspaceId,
		refreshingWsId,
		wsBranches,
		switchingBranch,
		switchingBranchName,
		branchPickerWsId,
		setBranchPickerWsId,
		wsBranchPos,
		setWsBranchPos,
		loadWorkspaces,
		switchWorkspace,
		handleDeleteWorkspace,
		handleRefreshWorkspace,
		loadWsBranches,
		handleSwitchBranch,
	};
}
