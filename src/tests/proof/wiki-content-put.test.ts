/**
 * Tests for PUT /api/wiki/content:
 * - auth required
 * - non-markdown plain write
 * - markdown with revision tracking
 * - stale revision → 409
 * - agent sees bumped revision after PUT
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;
let tmpRoot: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-put-test-"));
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-put-root-"));
	process.env.HOME = tmpHome;
	process.env.ROOT_DIR = tmpRoot;
	// Force root-dir module to pick up new ROOT_DIR
	const { setRootDir } = await import("../../lib/root-dir.js");
	setRootDir(tmpRoot);
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

import { PUT, GET } from "../../app/api/wiki/content/route.js";

async function makeUserCookie(): Promise<string> {
	const { auth, authReady } = await import("../../lib/auth/server.js");
	await authReady();
	const res = await auth.api.signUpEmail({
		body: {
			email: `put${Date.now()}${Math.random().toString(36).slice(2, 5)}@test.local`,
			password: "test1234!",
			name: "Put Test User",
		},
		asResponse: true,
	});
	if (!res.ok) throw new Error("signUpEmail failed: " + res.status);
	const setCookie = res.headers.get("set-cookie") ?? "";
	return setCookie
		.split(/,(?=[^ ])/)
		.map((c) => c.split(";")[0].trim())
		.join("; ");
}

function makePutReq(
	body: Record<string, unknown>,
	cookie: string,
): Request {
	return new Request("http://localhost:3000/api/wiki/content", {
		method: "PUT",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify(body),
	});
}

test("PUT without session → 401", async () => {
	const req = new Request("http://localhost:3000/api/wiki/content", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "test.md", content: "hi" }),
	});
	const res = await PUT(req);
	assert.equal(res.status, 401);
});

test("PUT markdown with session + baseRevision:0 on new file → 200, revision 1", async () => {
	const cookie = await makeUserCookie();
	const filePath = path.join(tmpRoot, "new.md");
	await writeFile(filePath, "# Hello\n", "utf-8");

	const req = makePutReq({ path: "new.md", content: "# Updated\n", baseRevision: 0 }, cookie);
	const res = await PUT(req);
	assert.equal(res.status, 200);
	const data = (await res.json()) as { ok: boolean; revision: number };
	assert.equal(data.ok, true);
	assert.equal(typeof data.revision, "number");
	assert.ok(data.revision >= 1);
});

test("PUT markdown with matching baseRevision → 200", async () => {
	const cookie = await makeUserCookie();
	const filePath = path.join(tmpRoot, "rev.md");
	await writeFile(filePath, "# Rev\n", "utf-8");

	// First save — baseRevision:0 for fresh file
	const r1 = await PUT(makePutReq({ path: "rev.md", content: "# Rev v1\n", baseRevision: 0 }, cookie));
	assert.equal(r1.status, 200);
	const d1 = (await r1.json()) as { revision: number };

	// Second save — matching baseRevision
	const r2 = await PUT(makePutReq({ path: "rev.md", content: "# Rev v2\n", baseRevision: d1.revision }, cookie));
	assert.equal(r2.status, 200);
	const d2 = (await r2.json()) as { revision: number };
	assert.equal(d2.revision, d1.revision + 1);
});

test("PUT markdown with stale baseRevision → 409", async () => {
	const cookie = await makeUserCookie();
	const filePath = path.join(tmpRoot, "stale.md");
	await writeFile(filePath, "# Stale\n", "utf-8");

	// First save to bump revision
	const r1 = await PUT(makePutReq({ path: "stale.md", content: "# v1\n", baseRevision: 0 }, cookie));
	assert.equal(r1.status, 200);

	// Second save with stale revision 0
	const r2 = await PUT(makePutReq({ path: "stale.md", content: "# v2\n", baseRevision: 0 }, cookie));
	assert.equal(r2.status, 409);
	const body = (await r2.json()) as { error: string; currentRevision: number };
	assert.equal(body.error, "STALE_REVISION");
	assert.ok(body.currentRevision >= 1);
});

test("PUT non-markdown file → 200, no revision field", async () => {
	const cookie = await makeUserCookie();
	const filePath = path.join(tmpRoot, "data.json");
	await writeFile(filePath, "{}", "utf-8");

	const req = makePutReq({ path: "data.json", content: '{"a":1}' }, cookie);
	const res = await PUT(req);
	assert.equal(res.status, 200);
	const data = (await res.json()) as { ok: boolean; revision?: number };
	assert.equal(data.ok, true);
	assert.equal(data.revision, undefined);
});

test("GET without auth → 401", async () => {
	const req = new Request("http://localhost:3000/api/wiki/content?path=read.md");
	const res = await GET(req);
	assert.equal(res.status, 401);
});
