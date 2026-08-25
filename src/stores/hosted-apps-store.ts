"use client";
import { create } from "zustand";
import { wsFetch } from "@/lib/workspace-client";

export interface HostedApp {
	slug: string;
	type: "node" | "html";
	workspaceId: string;
	relPath: string;
	createdAt: string;
}

export interface HostDialogRequest {
	/** Workspace-relative directory path being hosted. */
	relPath: string;
	/** Pre-filled, editable slug (kebab-cased directory name). */
	defaultSlug: string;
}

export interface CreateResult {
	ok: boolean;
	error?: string;
	message?: string;
}

interface HostedAppsState {
	apps: HostedApp[];
	loading: boolean;
	loaded: boolean;
	collapsed: boolean;
	dialog: HostDialogRequest | null;
	toggleCollapsed: () => void;
	refresh: () => Promise<void>;
	create: (input: { slug: string; relPath: string }) => Promise<CreateResult>;
	remove: (slug: string) => Promise<void>;
	openHostDialog: (relPath: string, defaultSlug: string) => void;
	closeHostDialog: () => void;
}

/** Kebab-case a directory name for a default slug (never guaranteed valid). */
export function kebabCase(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export const useHostedAppsStore = create<HostedAppsState>((set, get) => ({
	apps: [],
	loading: false,
	loaded: false,
	collapsed: true,
	dialog: null,

	toggleCollapsed: () => {
		const next = !get().collapsed;
		set({ collapsed: next });
		// Fetch on expand (on-demand, not background-polled).
		if (!next) void get().refresh();
	},

	refresh: async () => {
		set({ loading: true });
		try {
			const res = await wsFetch("/api/wiki/hosted-apps");
			if (!res.ok) {
				set({ loading: false, loaded: true });
				return;
			}
			const data = (await res.json()) as { apps: HostedApp[] };
			set({ apps: data.apps ?? [], loading: false, loaded: true });
		} catch {
			set({ loading: false, loaded: true });
		}
	},

	create: async ({ slug, relPath }) => {
		try {
			const res = await wsFetch("/api/wiki/hosted-apps", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug, type: "html", path: relPath }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
					message?: string;
				};
				return { ok: false, error: body.error, message: body.message };
			}
			await get().refresh();
			return { ok: true };
		} catch (e) {
			return { ok: false, message: String(e) };
		}
	},

	remove: async (slug) => {
		try {
			await wsFetch("/api/wiki/hosted-apps", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug }),
			});
		} finally {
			await get().refresh();
		}
	},

	openHostDialog: (relPath, defaultSlug) => set({ dialog: { relPath, defaultSlug } }),
	closeHostDialog: () => set({ dialog: null }),
}));
