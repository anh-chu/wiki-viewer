/**
 * In-memory token bucket rate limiter for registration attempts.
 *
 * Bucket size: 10 requests
 * Refill rate: 1 token per 6 seconds (= 10/min)
 */

interface Bucket {
	tokens: number;
	lastRefillAt: number;
}

const BUCKET_CAPACITY = 10;
const REFILL_INTERVAL_MS = 6_000; // 1 token per 6s = 10/min

// Module-level singleton keyed by IP (or "__global__" if no IP available)
const g = globalThis as typeof globalThis & {
	__wvRegBuckets?: Map<string, Bucket>;
};
if (!g.__wvRegBuckets) {
	g.__wvRegBuckets = new Map();
}
const buckets: Map<string, Bucket> = g.__wvRegBuckets;

function refill(bucket: Bucket): void {
	const now = Date.now();
	const elapsed = now - bucket.lastRefillAt;
	const tokensToAdd = Math.floor(elapsed / REFILL_INTERVAL_MS);
	if (tokensToAdd > 0) {
		bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + tokensToAdd);
		bucket.lastRefillAt = now;
	}
}

/** Returns true if request is allowed; false if rate limited. */
export function checkRegisterRateLimit(key: string): boolean {
	let bucket = buckets.get(key);
	if (!bucket) {
		bucket = { tokens: BUCKET_CAPACITY, lastRefillAt: Date.now() };
		buckets.set(key, bucket);
	}
	refill(bucket);
	if (bucket.tokens > 0) {
		bucket.tokens--;
		return true;
	}
	return false;
}

/** Reset all buckets — for tests only. */
export function _resetRegisterBuckets(): void {
	buckets.clear();
}
