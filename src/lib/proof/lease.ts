/**
 * Human edit-lease store (in-memory, globalThis for hot-reload survival).
 *
 * A lease is set when a human opens a .md doc in the editor and refreshed
 * via heartbeat while the doc stays open.  Its presence makes collab-state
 * "active" even before the human has typed a single suggestion (closes the
 * false-negative GPT-5.5 caught in the design review).
 *
 * TTL: LEASE_TTL_MS (default 90 s). Editor should heartbeat every ~30 s.
 *
 * Collab-generation counter:
 *   - Starts at 0 per path.
 *   - Increments on EVERY 0→1 transition (first setLease, or setLease after
 *     all prior leases expired) AND on every 1→0 transition (clearLease or
 *     expiry-on-read).
 *   - X-Collab-Revision = sidecar.revision + leaseGeneration(path).
 *     Any lease or sidecar state change therefore bumps the combined revision.
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

/** True if relPath has a non-expired lease RIGHT NOW (lazy-sweeps on check). */
function isLeaseActiveInternal(relPath: string): boolean {
	const s = store();
	const entry = s.leases.get(relPath);
	if (!entry) return false;
	if (Date.now() >= entry.expiresAt) {
		s.leases.delete(relPath);
		// 1→0 transition: bump generation
		s.generations.set(relPath, (s.generations.get(relPath) ?? 0) + 1);
		return false;
	}
	return true;
}

/**
 * Set (or refresh) a lease for relPath by userId.
 * Bumps the generation counter on a 0→1 transition.
 */
export function setLease(relPath: string, userId: string, ttlMs = LEASE_TTL_MS): void {
	const s = store();
	const wasActive = isLeaseActiveInternal(relPath);
	s.leases.set(relPath, { userId, expiresAt: Date.now() + ttlMs });
	if (!wasActive) {
		// 0→1 transition: bump generation
		s.generations.set(relPath, (s.generations.get(relPath) ?? 0) + 1);
	}
}

/** True if relPath has a current non-expired lease. */
export function hasActiveLease(relPath: string): boolean {
	return isLeaseActiveInternal(relPath);
}

/**
 * Clear the lease for relPath (on doc close).
 * Only clears if the existing lease belongs to userId.
 * Bumps generation on removal.
 */
export function clearLease(relPath: string, userId: string): void {
	const s = store();
	const entry = s.leases.get(relPath);
	if (!entry) return;
	// Still clear expired leases owned by the same user
	if (entry.userId === userId) {
		s.leases.delete(relPath);
		// 1→0 transition: bump generation
		s.generations.set(relPath, (s.generations.get(relPath) ?? 0) + 1);
	}
}

/**
 * Returns the monotonic-ish collab generation for relPath.
 * Increments on every 0→1 and 1→0 lease transition.
 */
export function leaseGeneration(relPath: string): number {
	return store().generations.get(relPath) ?? 0;
}

/** Reset store — for tests only. */
export function _resetLeaseStore(): void {
	const s = store();
	s.leases.clear();
	s.generations.clear();
}
