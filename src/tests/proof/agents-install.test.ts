/**
 * Tests for /api/agents/install, /api/agents/skill, /api/agents/skill.tar.gz
 */
import { test } from "node:test";
import assert from "node:assert/strict";

function makeMockRequest(url: string): Request {
	return new Request(url, { method: "GET" });
}

// Import routes
import { GET as installGET } from "../../app/api/agents/install/route.js";
import { GET as skillGET } from "../../app/api/agents/skill/route.js";
import { GET as tarGET } from "../../app/api/agents/skill.tar.gz/route.js";

test("GET /api/agents/install returns 200 with expected shape", async () => {
	const req = makeMockRequest("http://localhost:3000/api/agents/install");
	const res = await installGET(req as Parameters<typeof installGET>[0]);
	assert.equal(res.status, 200);

	const body = await res.json() as Record<string, unknown>;
	assert.equal(body.name, "wiki-viewer");
	assert.ok(typeof body.version === "string" && body.version.length > 0);
	assert.ok(typeof body.endpoint === "string" && body.endpoint.startsWith("http"));
	assert.ok(Array.isArray(body.routes) && (body.routes as unknown[]).length > 0);
	assert.ok(typeof body.skillTarball === "string");
	assert.ok(typeof body.bootstrapPrompt === "string" && body.bootstrapPrompt.length > 0);
	assert.ok(typeof body.humanInstructions === "string" && body.humanInstructions.length > 0);
	assert.ok(Array.isArray(body.ops) && (body.ops as unknown[]).length > 0);
});

test("GET /api/agents/skill returns 200 text/markdown with SKILL.md content", async () => {
	const req = makeMockRequest("http://localhost:3000/api/agents/skill");
	const res = await skillGET(req as Parameters<typeof skillGET>[0]);
	assert.equal(res.status, 200);

	const ct = res.headers.get("content-type") ?? "";
	assert.ok(ct.startsWith("text/markdown"), `Expected text/markdown, got: ${ct}`);

	const body = await res.text();
	assert.ok(body.startsWith("---\nname: wiki-viewer"), `Unexpected start: ${body.slice(0, 40)}`);
});

test("GET /api/agents/skill.tar.gz returns 200 gzip with magic bytes", async () => {
	const req = makeMockRequest("http://localhost:3000/api/agents/skill.tar.gz");
	const res = await tarGET(req as Parameters<typeof tarGET>[0]);
	assert.equal(res.status, 200);

	const ct = res.headers.get("content-type") ?? "";
	assert.equal(ct, "application/gzip");

	const buf = Buffer.from(await res.arrayBuffer());
	assert.ok(buf.length > 0, "tarball should not be empty");
	// gzip magic bytes
	assert.equal(buf[0], 0x1f);
	assert.equal(buf[1], 0x8b);
});
