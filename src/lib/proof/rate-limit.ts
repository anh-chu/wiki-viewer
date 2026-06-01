import { OPS_PER_MINUTE } from "../proof-config";

interface Bucket {
	tokens: number;
	lastRefill: number; // ms epoch
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket rate limiter per `by` identity.
 * Bucket size = OPS_PER_MINUTE (default 60).
 * Refill rate: 1 token/sec (continuous approximation).
 *
 * Returns { ok: true } when tokens consumed, or
 * { ok: false, retryAfterMs } when exhausted.
 */
export function checkAndConsume(
	by: string,
	n: number = 1,
): { ok: true } | { ok: false; retryAfterMs: number } {
	const now = Date.now();
	const bucketSize = OPS_PER_MINUTE;

	let bucket = buckets.get(by);
	if (!bucket) {
		bucket = { tokens: bucketSize, lastRefill: now };
		buckets.set(by, bucket);
	}

	// Refill: 1 token per 1000 ms elapsed
	const elapsed = now - bucket.lastRefill;
	const refill = Math.floor(elapsed / 1000);
	if (refill > 0) {
		bucket.tokens = Math.min(bucketSize, bucket.tokens + refill);
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
