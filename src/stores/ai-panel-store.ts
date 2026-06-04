"use client";
import { create } from "zustand";
import type { ActivityEvent } from "@/lib/proof/activity-shared";
import { wsFetch } from "@/lib/workspace-client";
import { deriveConnections } from "@/lib/proof/activity-shared";
import { authHeaders } from "@/lib/proof/client-auth";

export interface Connection {
	by: string;
	opCount: number;
	lastSeen: string;
}

interface AIPanelState {
	isOpen: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	clearMessages: () => void;

	activity: ActivityEvent[];
	connections: Connection[];
	hasToken: boolean;
	pollIntervalMs: number;
	rateLimit: number | null;

	loadActivity: () => Promise<void>;
}

export const useAIPanelStore = create<AIPanelState>((set) => ({
	isOpen: false,
	open: () => set({ isOpen: true }),
	close: () => set({ isOpen: false }),
	toggle: () => set((s) => ({ isOpen: !s.isOpen })),
	clearMessages: () => {
		/* no-op */
	},

	activity: [],
	connections: [],
	hasToken: false,
	pollIntervalMs: 10_000,
	rateLimit: null,

	loadActivity: async () => {
		const token =
			typeof window !== "undefined"
				? (localStorage.getItem("wiki-agent-token") ?? null)
				: null;
		const hasToken = !!(token && token.trim());

		try {
			const res = await wsFetch("/api/agent/activity?limit=50", {
				headers: authHeaders(),
			});
			if (!res.ok) {
				set({ hasToken });
				return;
			}
			const data = (await res.json()) as { events: ActivityEvent[] };
			const activity = data.events ?? [];
			const connections = deriveConnections(activity);

			// Also fetch rate-limit setting
			let rateLimit: number | null = null;
			try {
				const sr = await wsFetch("/api/agent/settings", { headers: authHeaders() });
				if (sr.ok) {
					const sd = (await sr.json()) as { rateLimit: number };
					rateLimit = sd.rateLimit ?? null;
				}
			} catch { /* ignore */ }

			set({ activity, connections, hasToken, rateLimit });
		} catch {
			set({ hasToken });
		}
	},
}));
