import type { ProofEvent, Sidecar } from "./types";

/**
 * Append one or more events to a working sidecar (in-memory mutation).
 * Assigns monotonic IDs from sidecar.nextEventId.
 */
export function emitEvents(
	sidecar: Sidecar,
	partials: Array<Omit<ProofEvent, "id">>,
): ProofEvent[] {
	const emitted: ProofEvent[] = [];
	for (const partial of partials) {
		const ev = { ...partial, id: sidecar.nextEventId++ } as ProofEvent;
		sidecar.events.push(ev);
		emitted.push(ev);
	}
	return emitted;
}

/**
 * Poll events after a given ID, up to limit.
 */
export function pollEvents(
	sidecar: Sidecar,
	afterId: number,
	limit: number,
): ProofEvent[] {
	return sidecar.events.filter((e) => e.id > afterId).slice(0, limit);
}

/**
 * Trim sidecar events to stay under TRIM_SIZE, preserving events newer than
 * the oldest lastAck cursor to avoid stranding agents.
 */
export function trimEvents(sidecar: Sidecar, trimSize: number): void {
	if (sidecar.events.length <= trimSize) return;

	const ackValues = Object.values(sidecar.lastAck);
	const oldestAck = ackValues.length > 0 ? Math.min(...ackValues) : Infinity;

	// Events to keep: either within trimSize from the end, OR above the oldest ack
	const keepFrom = sidecar.events.length - trimSize;
	const trimmedEvents = sidecar.events.filter(
		(e, i) => i >= keepFrom || e.id > oldestAck,
	);
	sidecar.events = trimmedEvents;
}
