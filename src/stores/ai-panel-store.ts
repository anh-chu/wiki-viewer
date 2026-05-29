"use client";
import { create } from "zustand";

// Minimal stub. The editor reads open/clearMessages/open from this store.
// Extend as needed when an AI panel is added to ccmc.

interface AIPanelState {
	isOpen: boolean;
	open: () => void;
	close: () => void;
	toggle: () => void;
	clearMessages: () => void;
}

export const useAIPanelStore = create<AIPanelState>((set) => ({
	isOpen: false,
	open: () => set({ isOpen: true }),
	close: () => set({ isOpen: false }),
	toggle: () => set((s) => ({ isOpen: !s.isOpen })),
	clearMessages: () => {
		/* no-op: no messages in stub */
	},
}));
