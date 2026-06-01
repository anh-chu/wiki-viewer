// Rate limiting: token bucket per "by" agent identity.
// Bucket size = OPS_PER_MINUTE, refill 1 op/sec.
export const OPS_PER_MINUTE = (() => {
	const v = parseInt(process.env.AGENT_RATE_LIMIT ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : 60;
})();

// Max events to return from a single poll.
export const EVENTS_MAX_LIMIT = 1000;
export const EVENTS_DEFAULT_LIMIT = 100;

// Sidecar event trimming: keep last N events (but never below oldest ack cursor).
export const SIDECAR_EVENT_TRIM_SIZE = 1000;
export const SIDECAR_TRIM_EVERY_N_MUTATIONS = 100;
