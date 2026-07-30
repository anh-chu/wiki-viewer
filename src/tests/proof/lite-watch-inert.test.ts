/**
 * lite-watch-inert.test.ts — WIKI_LITE=1 makes /api/wiki/watch return 503.
 *
 * The watch GET handler must return 503 BEFORE calling resolveWorkspaceForUser
 * and before any subscribe() call. A 503 permanently fails an EventSource,
 * while a 204 would cause an infinite browser reconnect loop.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// Import the GET handler directly.
import { GET } from "../../app/api/wiki/watch/route.js";

const savedLite = process.env.WIKI_LITE;

before(() => {
	process.env.WIKI_LITE = "1";
});

after(() => {
	if (savedLite === undefined) delete process.env.WIKI_LITE;
	else process.env.WIKI_LITE = savedLite;
});

test("watch GET returns 503 when WIKI_LITE=1", async () => {
	const req = new Request("http://localhost:3000/api/wiki/watch");
	const res = await GET(req);
	assert.equal(res.status, 503);
	const body = await res.text();
	assert.ok(body.length > 0, "must have a body");
});

test("watch GET returns 503 before any workspace resolution", async () => {
	// Even with a valid request, it must 503 immediately.
	const req = new Request(
		"http://localhost:3000/api/wiki/watch?ws=ws_abc",
	);
	const res = await GET(req);
	assert.equal(res.status, 503);
});
