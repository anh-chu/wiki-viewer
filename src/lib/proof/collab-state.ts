/**
 * Collab-state computation for §3.5 Working mode vs Collaborating mode.
 *
 * Returns:
 *   state     — "active" | "tracked" | "untracked" | "not-markdown"
 *   revision  — X-Collab-Revision (sidecar.revision + leaseGeneration(path))
 *   snapshotUrl — Tier-2 snapshot URL (null for non-markdown)
 *
 * Revision formula:
 *   revision = (sidecar?.revision ?? 0) + leaseGeneration(relPath)
 *
 *   sidecar.revision bumps on every collab write (block-ops, comment, suggestion).
 *   leaseGeneration bumps on every lease open/close.
 *   Together they form a monotonically-non-decreasing integer that changes
 *   whenever collab state could change.  A raw PUT that supplies
 *   If-Collab-Match: <n> is only safe when n equals the revision computed
 *   atomically inside the write mutex — otherwise 409 COLLAB_ACTIVE.
 *
 * active = has artifacts (pendingSuggestions > 0 OR unresolvedComments > 0
 *          OR blockProvenance entries > 0) OR has a current human edit lease.
 */

import { readSidecar } from "./sidecar";
import { hasActiveLease, leaseGeneration } from "./lease";

function isMarkdownPath(p: string): boolean {
	return p.endsWith(".md") || p.endsWith(".markdown");
}

export type CollabState = "active" | "tracked" | "untracked" | "not-markdown";

export interface CollabStateResult {
	state: CollabState;
	/** sidecar.revision + leaseGeneration(relPath) */
	revision: number;
	/** /api/agent/files/<relPath> — null for not-markdown */
	snapshotUrl: string | null;
}

export async function computeCollabState(
	rootDir: string,
	relPath: string,
): Promise<CollabStateResult> {
	if (!isMarkdownPath(relPath)) {
		return { state: "not-markdown", revision: 0, snapshotUrl: null };
	}

	const snapshotUrl = `/api/agent/files/${relPath}`;

	// Compute revision components
	// ns = rootDir: workspace-namespaces lease keys so two workspaces sharing
	// the same relPath never collide in the lease store.
	const sidecar = await readSidecar(rootDir, relPath);
	const gen = leaseGeneration(rootDir, relPath);
	const sidecarRevision = sidecar?.revision ?? 0;
	const revision = sidecarRevision + gen;

	// Lease check — do after reading sidecar to keep gen stable within this call
	const leaseActive = hasActiveLease(rootDir, relPath);

	if (!sidecar && !leaseActive) {
		return { state: "untracked", revision, snapshotUrl };
	}

	if (leaseActive) {
		return { state: "active", revision, snapshotUrl };
	}

	// Has sidecar, no lease — inspect artifacts
	const pendingSuggestions = sidecar!.suggestions.filter(
		(s) => s.status === "pending" && !s.stale,
	).length;
	const unresolvedComments = sidecar!.comments.filter((c) => !c.resolved).length;
	const proofSpanCount = Object.keys(sidecar!.blockProvenance ?? {}).length;

	if (pendingSuggestions > 0 || unresolvedComments > 0 || proofSpanCount > 0) {
		return { state: "active", revision, snapshotUrl };
	}

	return { state: "tracked", revision, snapshotUrl };
}
