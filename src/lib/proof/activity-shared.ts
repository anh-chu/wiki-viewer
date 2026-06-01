import type { ProofEvent } from "./types";

export interface ActivityEvent extends ProofEvent {
	path: string;
}

export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

/** Derive active connections from recent events (last 5 minutes). */
export function deriveConnections(
	events: ActivityEvent[],
): { by: string; opCount: number; lastSeen: string }[] {
	const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
	const map = new Map<string, { opCount: number; lastSeen: string }>();
	for (const ev of events) {
		if (ev.at < cutoff) continue;
		const existing = map.get(ev.by);
		if (!existing) {
			map.set(ev.by, { opCount: 1, lastSeen: ev.at });
		} else {
			map.set(ev.by, {
				opCount: existing.opCount + 1,
				lastSeen: ev.at > existing.lastSeen ? ev.at : existing.lastSeen,
			});
		}
	}
	return Array.from(map.entries())
		.map(([by, v]) => ({ by, ...v }))
		.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}
