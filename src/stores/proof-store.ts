import { create } from "zustand";
import { authHeaders } from "@/lib/proof/client-auth";
import { wsFetch } from "@/lib/workspace-client";
import { useEditorStore } from "@/stores/editor-store";
import type { Sidecar, ProofEvent, Block, Snapshot } from "@/lib/proof/types";

interface PathEntry {
	sidecar: Sidecar | null;
	snapshotRevision: number;
	lastEventId: number;
	/** Ordered block list from latest GET snapshot. Used to resolve ref→position in editor. */
	snapshotBlocks: Block[];
}

interface ProofState {
	byPath: Record<string, PathEntry>;
	loadSidecar(path: string): Promise<void>;
	/** Fetch GET /api/agent/files/<path> to get ordered block list for ref positioning. */
	loadSnapshot(path: string): Promise<void>;
	pollEvents(path: string): Promise<void>;
	applyEvent(path: string, e: ProofEvent): void;
	reset(path: string): void;
}

function defaultEntry(): PathEntry {
	return { sidecar: null, snapshotRevision: 0, lastEventId: 0, snapshotBlocks: [] };
}

export const useProofStore = create<ProofState>((set, get) => ({
	byPath: {},

	loadSidecar: async (path: string) => {
		const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
		try {
			const res = await wsFetch(`/api/agent/sidecar/${encoded}`, {
				headers: authHeaders(),
			});
			if (!res.ok) return;
			const sidecar = (await res.json()) as Sidecar;
			set((s) => ({
				byPath: {
					...s.byPath,
					[path]: {
						...(s.byPath[path] ?? defaultEntry()),
						sidecar,
						snapshotRevision: sidecar.revision,
						lastEventId: sidecar.nextEventId - 1,
					},
				},
			}));
		} catch {
			// network error — leave stale
		}
	},

	loadSnapshot: async (path: string) => {
		const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
		try {
			const res = await wsFetch(`/api/agent/files/${encoded}`, {
				headers: authHeaders(),
			});
			if (!res.ok) return;
			const snap = (await res.json()) as Snapshot;
			set((s) => ({
				byPath: {
					...s.byPath,
					[path]: {
						...(s.byPath[path] ?? defaultEntry()),
						snapshotBlocks: snap.blocks,
						snapshotRevision: snap.revision,
					},
				},
			}));
			// Sync revision into editor-store so saves send correct baseRevision.
			const editorState = useEditorStore.getState();
			if (editorState.currentPath === path) {
				editorState.syncRevision(snap.revision);
			}
		} catch {
			// network error — leave stale
		}
	},

	pollEvents: async (path: string) => {
		const entry = get().byPath[path] ?? defaultEntry();
		const encoded = encodeURIComponent(path).replace(/%2F/g, "/");
		try {
			const res = await wsFetch(
				`/api/agent/events/${encoded}?after=${entry.lastEventId}`,
				{ headers: authHeaders() },
			);
			if (!res.ok) return;
			const data = (await res.json()) as { events: ProofEvent[]; lastEventId: number };
			for (const e of data.events) {
				get().applyEvent(path, e);
			}
		} catch {
			// network error — leave stale
		}
	},

	applyEvent: (path: string, e: ProofEvent) => {
		set((s) => {
			const prev = s.byPath[path] ?? defaultEntry();
			return {
				byPath: {
					...s.byPath,
					[path]: {
						...prev,
						lastEventId: Math.max(prev.lastEventId, e.id),
					},
				},
			};
		});
	},

	reset: (path: string) => {
		set((s) => {
			const next = { ...s.byPath };
			delete next[path];
			return { byPath: next };
		});
	},
}));
