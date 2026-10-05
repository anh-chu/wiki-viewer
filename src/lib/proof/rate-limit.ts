import { OPS_PER_MINUTE } from "../proof-config";

interface Bucket {
	tokens: number;
	lastRefill: number; // ms epoch
	size: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket rate limiter per `by` identity.
 * Bucket size = `bucketSize`, defaulting to OPS_PER_MINUTE (60). A bucket keeps
 * the size it was first created with, so callers must pass a stable size for a
 * given key. Used by public share asset requests, where one folder page can
 * load many files, to raise the allowance above the agent default.
 * Refill rate: 1 token/sec (continuous approximation).
 *
 * Returns { ok: true } when tokens consumed, or
 * { ok: false, retryAfterMs } when exhausted.
 */
export function checkAndConsume(
	by: string,
	n: number = 1,
	bucketSize: number = OPS_PER_MINUTE,
): { ok: true } | { ok: false; retryAfterMs: number } {
	const now = Date.now();

	let bucket = buckets.get(by);
	if (!bucket) {
		bucket = { tokens: bucketSize, lastRefill: now, size: bucketSize };
		buckets.set(by, bucket);
	}

	// Refill: 1 token per 1000 ms elapsed
	const elapsed = now - bucket.lastRefill;
	const refill = Math.floor(elapsed / 1000);
	if (refill > 0) {
		bucket.tokens = Math.min(bucket.size, bucket.tokens + refill);
		bucket.lastRefill = bucket.lastRefill + refill * 1000;
	}

	if (bucket.tokens < n) {
		// How long until we have n tokens?
		const needed = n - bucket.tokens;
		const retryAfterMs = needed * 1000 - (now - bucket.lastRefill);
		return { ok: false, retryAfterMs: Math.max(1, retryAfterMs) };
	}

	bucket.tokens -= n;
	return { ok: true };
}

/** Exposed for tests only — reset all buckets. */
export function _resetBuckets(): void {
	buckets.clear();
}
