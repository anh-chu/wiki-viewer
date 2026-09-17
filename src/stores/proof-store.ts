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
			set((s) => {
				const current = s.byPath[path];
				// A delayed initial load can finish after a local annotation op. Do not
				// replace the newer in-memory sidecar (and its pips) with that stale read.
				if (current?.sidecar && current.sidecar.revision > sidecar.revision) return s;
				return {
					byPath: {
						...s.byPath,
						[path]: {
							...(current ?? defaultEntry()),
							sidecar,
							snapshotRevision: Math.max(current?.snapshotRevision ?? 0, sidecar.revision),
							lastEventId: Math.max(current?.lastEventId ?? 0, sidecar.nextEventId - 1),
						},
					},
				};
			});
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
			const sidecar = prev.sidecar ? { ...prev.sidecar } : null;
			if (sidecar) {
				sidecar.comments = [...sidecar.comments];
				sidecar.suggestions = [...sidecar.suggestions];
				sidecar.archivedSuggestions = [...sidecar.archivedSuggestions];
				const commentId = typeof e.commentId === "string" ? e.commentId : undefined;
				const suggestionId = typeof e.suggestionId === "string" ? e.suggestionId : undefined;
				if (e.type === "comment.added" && e.comment && typeof e.comment === "object") {
					sidecar.comments.push(e.comment as Sidecar["comments"][number]);
				} else if (e.type === "comment.replied" && commentId) {
					const comment = sidecar.comments.find((c) => c.id === commentId);
					if (comment && typeof e.text === "string") comment.turns = [...comment.turns, { by: e.by, text: e.text, at: e.at }];
				} else if (e.type === "comment.edited" && commentId && typeof e.text === "string") {
					const comment = sidecar.comments.find((c) => c.id === commentId);
					if (comment?.turns[0]) comment.turns = [{ ...comment.turns[0], text: e.text }, ...comment.turns.slice(1)];
				} else if (e.type === "comment.deleted" && commentId) {
					sidecar.comments = sidecar.comments.filter((c) => c.id !== commentId);
				} else if ((e.type === "comment.resolved" || e.type === "comment.reopened") && commentId) {
					const comment = sidecar.comments.find((c) => c.id === commentId);
					if (comment) comment.resolved = e.type === "comment.resolved";
				} else if (e.type === "suggestion.added" && e.suggestion && typeof e.suggestion === "object") {
					sidecar.suggestions.push(e.suggestion as Sidecar["suggestions"][number]);
				} else if (e.type === "suggestion.edited" && suggestionId) {
					const suggestion = sidecar.suggestions.find((item) => item.id === suggestionId);
					if (suggestion) {
						if (e.kind !== undefined) suggestion.kind = e.kind as typeof suggestion.kind;
						if (e.markdown !== undefined) suggestion.markdown = e.markdown as string;
						if (e.range !== undefined) suggestion.range = e.range as typeof suggestion.range;
					}
				} else if (e.type === "suggestion.deleted" && suggestionId) {
					sidecar.suggestions = sidecar.suggestions.filter((item) => item.id !== suggestionId);
				}
				sidecar.events = [...sidecar.events, e];
				sidecar.nextEventId = Math.max(sidecar.nextEventId, e.id + 1);
				sidecar.revision = typeof e.revision === "number" ? e.revision : sidecar.revision;
				sidecar.updatedAt = e.at;
			}
			return { byPath: { ...s.byPath, [path]: { ...prev, sidecar, snapshotRevision: typeof e.revision === "number" ? e.revision : prev.snapshotRevision, lastEventId: Math.max(prev.lastEventId, e.id) } } };
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
