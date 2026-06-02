/**
 * Per-path cache for last-known file metadata from GET responses.
 * Drives If-Match and collab-state checks on subsequent writes.
 */

export type CollabState = "active" | "tracked" | "untracked" | "not-markdown";

export interface PathState {
  /** sha256 from ETag header (without quotes) */
  sha256: string;
  collabState: CollabState;
  /** X-Collab-Revision value, null for non-markdown */
  collabRevision: number | null;
  /** X-Collab-Snapshot URL, null for non-markdown */
  collabSnapshot: string | null;
  /** When this cache entry was last updated (ms) */
  fetchedAt: number;
}

const cache = new Map<string, PathState>();

export function set(path: string, state: PathState): void {
  cache.set(normalisePath(path), state);
}

export function get(path: string): PathState | undefined {
  return cache.get(normalisePath(path));
}

export function del(path: string): void {
  cache.delete(normalisePath(path));
}

export function rename(from: string, to: string): void {
  const s = cache.get(normalisePath(from));
  if (s) {
    cache.delete(normalisePath(from));
    cache.set(normalisePath(to), s);
  }
}

/** Normalise leading slash away so 'foo/bar' and '/foo/bar' are the same key */
function normalisePath(p: string): string {
  return p.replace(/^\/+/, "");
}
