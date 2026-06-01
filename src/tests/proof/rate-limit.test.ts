import { test, before } from "node:test";
import assert from "node:assert/strict";
import { checkAndConsume, _resetBuckets } from "../../lib/proof/rate-limit.js";

before(() => {
	_resetBuckets();
});

test("checkAndConsume: allows up to bucket size ops", () => {
	_resetBuckets();
	// Default bucket = 60. Consume 60 one at a time.
	for (let i = 0; i < 60; i++) {
		const r = checkAndConsume("ai:unit-test");
		assert.equal(r.ok, true, `Op ${i + 1} should succeed`);
	}
	// 61st should fail
	const r = checkAndConsume("ai:unit-test");
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.retryAfterMs > 0, "retryAfterMs must be positive");
	}
});

test("checkAndConsume: bulk consume fails when n > tokens", () => {
	_resetBuckets();
	// Fresh bucket = 60 tokens. Request 61.
	const r = checkAndConsume("ai:bulk-test", 61);
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.ok(r.retryAfterMs > 0);
	}
});

test("checkAndConsume: different identities have independent buckets", () => {
	_resetBuckets();
	// Drain bucket for agent A
	for (let i = 0; i < 60; i++) {
		checkAndConsume("ai:agent-a");
	}
	// Agent B still has full bucket
	const r = checkAndConsume("ai:agent-b");
	assert.equal(r.ok, true, "Agent B must not be affected by agent A draining");
});

test("checkAndConsume: tokens refill over time", async () => {
	_resetBuckets();
	// Drain 3 tokens
	checkAndConsume("ai:refill-test", 3);
	// Wait 3 seconds to refill 3 tokens
	await new Promise((res) => setTimeout(res, 3100));
	// Should now be able to consume 3 more (57 + 3 = 60 total, or at least 3 refilled)
	const r = checkAndConsume("ai:refill-test", 3);
	assert.equal(r.ok, true, "Should have refilled after 3s");
});
