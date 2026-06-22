"use client";
import { create } from "zustand";

// Lab toggles for reading-UX features still behind a flag. Each is a
// self-contained component gated on its flag. Persisted to localStorage.

export type ExperimentId = "focusMode" | "breadcrumb" | "outlineSpine";

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
	{
		id: "outlineSpine",
		label: "Outline spine",
		description: "Glowing progress spine on the active outline section.",
	},
];

const STORAGE_KEY = "wiki-experiments";

type Flags = Record<ExperimentId, boolean>;

function loadInitial(): Flags {
	const base = Object.fromEntries(EXPERIMENTS.map((e) => [e.id, false])) as Flags;
	if (typeof window === "undefined") return base;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const saved = raw ? (JSON.parse(raw) as Partial<Record<string, boolean>>) : {};
		for (const e of EXPERIMENTS) {
			if (typeof saved[e.id] === "boolean") base[e.id] = saved[e.id] as boolean;
		}
	} catch {
		// ignore malformed storage
	}
	return base;
}

function persist(flags: Flags) {
	if (typeof window === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
	} catch {
		// quota / private mode — non-fatal
	}
}

interface ExperimentsState {
	flags: Flags;
	toggle: (id: ExperimentId) => void;
}

export const useExperimentsStore = create<ExperimentsState>((set) => ({
	flags: loadInitial(),
	toggle: (id) =>
		set((s) => {
			const flags = { ...s.flags, [id]: !s.flags[id] };
			persist(flags);
			return { flags };
		}),
}));

/** Subscribe to a single experiment flag. */
export function useExperiment(id: ExperimentId): boolean {
	return useExperimentsStore((s) => s.flags[id]);
}
