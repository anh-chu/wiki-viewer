"use client";

import {
	Check,
	ChevronDown,
	FolderPlus,
	GitBranch,
	RefreshCw,
	Server,
	Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BranchDropdown } from "@/components/wiki/branch-dropdown";
import { cn } from "@/lib/utils";
import type { WorkspaceSummary } from "@/hooks/use-workspaces";

function timeAgo(iso: string): string {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "";
	const diff = Math.max(0, Date.now() - t);
	const s = Math.floor(diff / 1000);
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export interface WorkspaceMenuProps {
	workspaces: WorkspaceSummary[];
	activeWorkspaceId: string | null;
	rootPath: string | null;
	isWsAdmin: boolean;
	refreshingWsId: string | null;
	switchingBranch: string | null;
	switchingBranchName: string | null;
	wsBranches: Record<string, string[]>;
	branchPickerWsId: string | null;
	wsBranchPos: { top: number; left: number } | null;
	onSwitchWorkspace: (id: string) => void;
	onRefreshWorkspace: (id: string) => void;
	onPromptDeleteWorkspace: (id: string) => void;
	onAddWorkspace: () => void;
	setBranchPickerWsId: (id: string | null) => void;
	setWsBranchPos: (pos: { top: number; left: number } | null) => void;
	loadWsBranches: (id: string) => void;
	handleSwitchBranch: (id: string, branch: string) => void;
}

export function WorkspaceMenu({
	workspaces,
	activeWorkspaceId,
	rootPath,
	isWsAdmin,
	refreshingWsId,
	switchingBranch,
	switchingBranchName,
	wsBranches,
	branchPickerWsId,
	wsBranchPos,
	onSwitchWorkspace,
	onRefreshWorkspace,
	onPromptDeleteWorkspace,
	onAddWorkspace,
	setBranchPickerWsId,
	setWsBranchPos,
	loadWsBranches,
	handleSwitchBranch,
}: WorkspaceMenuProps) {
	return (
		<div className="border-t px-2 py-2 bg-muted shrink-0">
			<DropdownMenu
				modal={false}
				onOpenChange={(o) => {
					if (!o) {
						setBranchPickerWsId(null);
						setWsBranchPos(null);
					}
				}}
			>
				<DropdownMenuTrigger asChild>
					<Button
						size="sm"
						variant="ghost"
						className="w-full h-auto justify-between gap-2 px-2 py-1.5 text-left"
						title={rootPath ?? ""}
					>
						<span className="flex flex-col min-w-0">
							<span className="truncate text-xs font-medium">
								{workspaces.find((w) => w.id === activeWorkspaceId)?.name ??
									"Workspace"}
							</span>
							<span className="truncate text-[10px] text-muted-foreground font-mono">
								{rootPath ?? ""}
							</span>
						</span>
						<ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-[var(--radix-dropdown-menu-trigger-width)]"
					onInteractOutside={(e) => {
						if (
							(e.target as HTMLElement | null)?.closest?.(
								"[data-branch-portal]",
							)
						)
							e.preventDefault();
						}}
				>
					{workspaces.map((w) => (
						<DropdownMenuItem
							key={w.id}
							onClick={() => void onSwitchWorkspace(w.id)}
							onPointerMove={(e) => e.preventDefault()}
							onPointerLeave={(e) => e.preventDefault()}
							className={cn(
								"gap-2",
								w.id === activeWorkspaceId && "font-medium",
							)}
						>
							{w.id === activeWorkspaceId ? (
								<Check className="h-3.5 w-3.5 shrink-0" />
							) : (
								<span className="w-3.5 shrink-0" />
							)}
							<span className="flex flex-col min-w-0 flex-1">
								<span className="flex items-center gap-1.5 truncate">
									<span className="truncate">{w.name}</span>
									{w.git ? (
										isWsAdmin ? (
											<button
												data-branch-trigger
												type="button"
												className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0 hover:bg-accent"
												title="Switch branch"
												disabled={switchingBranch === w.id}
												onClick={(e) => {
													e.stopPropagation();
													e.preventDefault();
													if (branchPickerWsId === w.id) {
														setBranchPickerWsId(null);
														setWsBranchPos(null);
														return;
													}
													const rect = (
														e.currentTarget as HTMLElement
													).getBoundingClientRect();
													setWsBranchPos({
														top: rect.bottom + 4,
														left: rect.left,
													});
													setBranchPickerWsId(w.id);
													void loadWsBranches(w.id);
												}}
											>
												<GitBranch className="h-2.5 w-2.5" />{" "}
												{w.git.branch ?? "branch"}
											</button>
										) : (
											<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
												<GitBranch className="h-2.5 w-2.5" />{" "}
												{w.git.branch ?? "read-only"}
											</span>
										)
									) : w.ssh ? (
										<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
											<Server className="h-2.5 w-2.5" /> {w.ssh.host}
										</span>
									) : w.readOnly ? (
										<span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] text-muted-foreground font-normal shrink-0">
											<GitBranch className="h-2.5 w-2.5" /> read-only
										</span>
									) : null}
								</span>
								<span className="truncate text-[10px] text-muted-foreground font-mono">
									{w.rootDir}
								</span>
								{w.git?.lastPulledAt && timeAgo(w.git.lastPulledAt) && (
									<span className="text-[10px] text-muted-foreground/70">
										synced {timeAgo(w.git.lastPulledAt)}
									</span>
								)}
								{/* branch picker rendered standalone below, outside the menu's focus scope */}
							</span>
							{isWsAdmin && w.git && (
								<button
									className={cn(
										"shrink-0 rounded p-0.5 hover:bg-accent transition-colors",
										w.git.lastError
											? "text-destructive"
											: "text-muted-foreground hover:text-foreground",
									)}
									title={
										w.git.lastError
											? `Last refresh failed: ${w.git.lastError}`
											: "Refresh"
									}
									disabled={refreshingWsId === w.id}
									onClick={(e) => {
										e.stopPropagation();
										e.preventDefault();
										void onRefreshWorkspace(w.id);
									}}
								>
									<RefreshCw
										className={cn(
											"h-3.5 w-3.5",
											refreshingWsId === w.id && "animate-spin",
										)}
									/>
								</button>
							)}
							{isWsAdmin && (
								<button
									className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
									title="Delete workspace (does not delete files)"
									onClick={(e) => {
										e.stopPropagation();
										onPromptDeleteWorkspace(w.id);
									}}
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							)}
						</DropdownMenuItem>
					))}
					{isWsAdmin && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={onAddWorkspace}>
								<FolderPlus className="mr-2 h-3.5 w-3.5" />
								Add workspace…
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{(() => {
				if (!branchPickerWsId || !wsBranchPos) return null;
				const w = workspaces.find((x) => x.id === branchPickerWsId);
				if (!w) return null;
				return (
					<BranchDropdown
						pos={wsBranchPos}
						branches={(wsBranches[w.id] ?? []).map((b) => ({
							name: b,
							current: b === w.git?.branch,
						}))}
						loading={!wsBranches[w.id]}
						busyName={
							switchingBranch === w.id ? switchingBranchName : null
						}
						disabled={switchingBranch === w.id}
						onPick={(name) => {
							void handleSwitchBranch(w.id, name);
						}}
						onClose={() => {
							setBranchPickerWsId(null);
							setWsBranchPos(null);
						}}
					/>
				);
			})()}
		</div>
	);
}
