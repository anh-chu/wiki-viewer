"use client";
import { create } from "zustand";
import type { TreeNode } from "@/types";

// Minimal stub used by folder-index.tsx navigation callbacks.
// The editor's folder navigation (selectPage, expandPath) is wired here.
// ccmc doesn't have a global tree sidebar, so these are local no-ops
// that still satisfy the type contract.

interface TreeState {
	nodes: TreeNode[];
	selectedPath: string | null;
	expandedPaths: Set<string>;

	loadTree: () => Promise<void>;
	selectPage: (path: string | null) => void;
	expandPath: (path: string) => void;
	focusPath: (path: string) => void;
}

export const useTreeStore = create<TreeState>((set, get) => ({
	nodes: [],
	selectedPath: null,
	expandedPaths: new Set<string>(),

	loadTree: async () => {
		// No-op in ccmc; the documents page manages its own tree.
	},

	selectPage: (path: string | null) => {
		set({ selectedPath: path });
	},

	expandPath: (path: string) => {
		const { expandedPaths } = get();
		if (!expandedPaths.has(path)) {
			const next = new Set(expandedPaths);
			next.add(path);
			set({ expandedPaths: next });
		}
	},

	focusPath: (path: string) => {
		const { expandedPaths } = get();
		const next = new Set(expandedPaths);
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			next.add(parts.slice(0, i).join("/"));
		}
		set({ selectedPath: path, expandedPaths: next });
	},
}));
