"use client";
import { create } from "zustand";

// Lab / experiment flags for reading-UX features. Each experiment is a
// self-contained component gated on its flag; nothing here knows how a
// feature is implemented, only whether it is on. Persisted to localStorage.

export type ExperimentId = "focusMode" | "breadcrumb";

export const EXPERIMENTS: { id: ExperimentId; label: string; description: string }[] = [
	{
		id: "focusMode",
		label: "Focus mode",
		description: "Dim everything except the block you're reading.",
	},
	{
		id: "breadcrumb",
		label: "Sticky breadcrumb",
		description: "Current heading trail pinned to the top while you scroll.",
	},
];

const STORAGE_KEY = "wiki-experiments";

type Flags = Record<ExperimentId, boolean>;

function loadInitial(): Flags {
	const base = Object.fromEntries(EXPERIMENTS.map((e) => [e.id, false])) as Flags;
	if (typeof window === "undefined") return base;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) Object.assign(base, JSON.parse(raw));
	} catch {
		// ignore malformed storage
	}
	return base;
}

function persist(flags: Flags) {
	if (typeof window !== "undefined") {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
	}
}

interface ExperimentsState {
	flags: Flags;
	toggle: (id: ExperimentId) => void;
	set: (id: ExperimentId, on: boolean) => void;
}

export const useExperimentsStore = create<ExperimentsState>((set) => ({
	flags: loadInitial(),
	toggle: (id) =>
		set((s) => {
			const flags = { ...s.flags, [id]: !s.flags[id] };
			persist(flags);
			return { flags };
		}),
	set: (id, on) =>
		set((s) => {
			const flags = { ...s.flags, [id]: on };
			persist(flags);
			return { flags };
		}),
}));

/** Subscribe to a single experiment flag. */
export function useExperiment(id: ExperimentId): boolean {
	return useExperimentsStore((s) => s.flags[id]);
}
