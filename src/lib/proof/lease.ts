/**
 * Human edit-lease store (in-memory, globalThis for hot-reload survival).
 *
 * Namespace choice (workspacing): the first argument to every public function
 * is `ns` — a namespace string that MUST be the workspace rootDir (or wsId in
 * future phases).  The internal map key is `${ns}\u0000${relPath}`.  Two
 * workspaces that share the same relative path (e.g. "notes.md") therefore
 * never collide.  Phase B routes pass rootDir from resolveWorkspaceForUser;
 * Phase A callers pass getRootDir() or tmpRoot in tests.
 *
 * A lease is set when a human opens a .md doc in the editor and refreshed
 * via heartbeat while the doc stays open.  Its presence makes collab-state
 * "active" even before the human has typed a single suggestion.
 *
 * TTL: LEASE_TTL_MS (default 90 s). Editor should heartbeat every ~30 s.
 *
 * Collab-generation counter:
 *   - Starts at 0 per (ns, path).
 *   - Increments on EVERY 0→1 transition (first setLease, or setLease after
 *     all prior leases expired) AND on every 1→0 transition (clearLease or
 *     expiry-on-read).
 *   - X-Collab-Revision = sidecar.revision + leaseGeneration(ns, path).
 */

export const LEASE_TTL_MS = 90_000;

interface LeaseEntry {
	userId: string;
	expiresAt: number;
}

interface LeaseStore {
	leases: Map<string, LeaseEntry>;
	generations: Map<string, number>;
}

const g = globalThis as typeof globalThis & { __wikiLeaseStore?: LeaseStore };
if (!g.__wikiLeaseStore) {
	g.__wikiLeaseStore = { leases: new Map(), generations: new Map() };
}

function store(): LeaseStore {
	return g.__wikiLeaseStore!;
}

function storeKey(ns: string, relPath: string): string {
	return `${ns}\u0000${relPath}`;
}

/** True if (ns, relPath) has a non-expired lease RIGHT NOW (lazy-sweeps on check). */
function isLeaseActiveInternal(ns: string, relPath: string): boolean {
	const s = store();
	const key = storeKey(ns, relPath);
	const entry = s.leases.get(key);
	if (!entry) return false;
	if (Date.now() >= entry.expiresAt) {
		s.leases.delete(key);
		// 1→0 transition: bump generation
		s.generations.set(key, (s.generations.get(key) ?? 0) + 1);
		return false;
	}
	return true;
}

/**
 * Set (or refresh) a lease for (ns, relPath) by userId.
 * Bumps the generation counter on a 0→1 transition.
 * `ns` must be the workspace rootDir (or a stable workspace identifier).
 */
export function setLease(ns: string, relPath: string, userId: string, ttlMs = LEASE_TTL_MS): void {
	const s = store();
	const key = storeKey(ns, relPath);
	const wasActive = isLeaseActiveInternal(ns, relPath);
	s.leases.set(key, { userId, expiresAt: Date.now() + ttlMs });
	if (!wasActive) {
		// 0→1 transition: bump generation
		s.generations.set(key, (s.generations.get(key) ?? 0) + 1);
	}
}

/** True if (ns, relPath) has a current non-expired lease. */
export function hasActiveLease(ns: string, relPath: string): boolean {
	return isLeaseActiveInternal(ns, relPath);
}

/**
 * Clear the lease for (ns, relPath) (on doc close).
 * Only clears if the existing lease belongs to userId.
 * Bumps generation on removal.
 */
export function clearLease(ns: string, relPath: string, userId: string): void {
	const s = store();
	const key = storeKey(ns, relPath);
	const entry = s.leases.get(key);
	if (!entry) return;
	if (entry.userId === userId) {
		s.leases.delete(key);
		// 1→0 transition: bump generation
		s.generations.set(key, (s.generations.get(key) ?? 0) + 1);
	}
}

/**
 * Returns the monotonic-ish collab generation for (ns, relPath).
 * Increments on every 0→1 and 1→0 lease transition.
 */
export function leaseGeneration(ns: string, relPath: string): number {
	const key = storeKey(ns, relPath);
	return store().generations.get(key) ?? 0;
}

/** Reset store — for tests only. */
export function _resetLeaseStore(): void {
	const s = store();
	s.leases.clear();
	s.generations.clear();
}
