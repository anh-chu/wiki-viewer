/**
 * Auth and CSRF enforcement tests for /api/wiki/* routes.
 *
 * Verifies:
 * - Unauthenticated requests to protected endpoints → 401
 * - Cross-origin state-changing requests → 403
 * - Same-origin state-changing requests pass the CSRF check
 * - baseRevision required for markdown PUT → 400 BASE_REVISION_REQUIRED
 * - Stale baseRevision → 409 STALE_REVISION
 * - Happy-path markdown PUT → 200 with revision header
 * - GET with auth returns X-Wiki-Revision + X-Wiki-Fingerprint for markdown
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;
let tmpRoot: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-auth-routes-test-"));
	process.env.HOME = tmpHome;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";

	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-auth-routes-root-"));
	process.env.ROOT_DIR = tmpRoot;

	const { setRootDir } = await import("../../lib/root-dir.js");
	setRootDir(tmpRoot);

	// Pre-create test files so routes can operate
	await mkdir(path.join(tmpRoot, "sub"), { recursive: true });
	await writeFile(path.join(tmpRoot, "auth-test.md"), "# Auth Test\n", "utf-8");
	await writeFile(path.join(tmpRoot, "stale.md"), "# Stale\n", "utf-8");
	await writeFile(path.join(tmpRoot, "happy.md"), "# Happy\n", "utf-8");
	await writeFile(path.join(tmpRoot, "rev-check.md"), "# Rev\n", "utf-8");
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

import { GET as wikiContentGET, PUT as wikiContentPUT } from "../../app/api/wiki/content/route.js";
import { POST as wikiMovePOST } from "../../app/api/wiki/move/route.js";
import { POST as wikiUploadPOST } from "../../app/api/wiki/upload/route.js";
import { DELETE as wikiRootDELETE } from "../../app/api/wiki/route.js";
import { makeUserSession } from "./helpers/auth-session.js";

// ─── Unauthenticated → 401 ───────────────────────────────────────────────────

test("GET /api/wiki/content without cookie → 401", async () => {
	const req = new Request("http://localhost:3000/api/wiki/content?path=auth-test.md");
	const res = await wikiContentGET(req);
	assert.equal(res.status, 401);
});

test("POST /api/wiki/upload without cookie → 401", async () => {
	const formData = new FormData();
	formData.append("file", new Blob(["hello"], { type: "text/plain" }), "test.txt");
	formData.append("path", "test.txt");
	const req = new Request("http://localhost:3000/api/wiki/upload", {
		method: "POST",
		body: formData,
	});
	const res = await wikiUploadPOST(req);
	assert.equal(res.status, 401);
});

test("POST /api/wiki/move without cookie → 401", async () => {
	const req = new Request("http://localhost:3000/api/wiki/move", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ from: "auth-test.md", to: "renamed.md" }),
	});
	const res = await wikiMovePOST(req);
	assert.equal(res.status, 401);
});

test("DELETE /api/wiki without cookie → 401", async () => {
	const req = new Request("http://localhost:3000/api/wiki?path=auth-test.md", {
		method: "DELETE",
	});
	const res = await wikiRootDELETE(req);
	assert.equal(res.status, 401);
});

// ─── CSRF origin checks ───────────────────────────────────────────────────────

test("POST /api/wiki/move with valid session + bad origin → 403", async () => {
	const cookie = await makeUserSession();
	const req = new Request("http://localhost:3000/api/wiki/move", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: "https://evil.com",
		},
		body: JSON.stringify({ from: "auth-test.md", to: "hacked.md" }),
	});
	const res = await wikiMovePOST(req);
	assert.equal(res.status, 403);
});

test("POST /api/wiki/move with valid session + matching origin → not 403/401", async () => {
	const cookie = await makeUserSession();
	const req = new Request("http://localhost:3000/api/wiki/move", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: "http://localhost:3000",
		},
		body: JSON.stringify({ from: "nonexistent-file.md", to: "also-nonexistent.md" }),
	});
	const res = await wikiMovePOST(req);
	// CSRF and auth passed — will fail at file-system level (404 or 400), not 403/401
	assert.notEqual(res.status, 403);
	assert.notEqual(res.status, 401);
});

// ─── baseRevision enforcement ─────────────────────────────────────────────────

test("PUT /api/wiki/content markdown + no baseRevision → 400 BASE_REVISION_REQUIRED", async () => {
	const cookie = await makeUserSession();
	const req = new Request("http://localhost:3000/api/wiki/content", {
		method: "PUT",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ path: "auth-test.md", content: "# Updated\n" }),
	});
	const res = await wikiContentPUT(req);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "BASE_REVISION_REQUIRED");
});

test("PUT /api/wiki/content markdown + stale baseRevision → 409 STALE_REVISION", async () => {
	const cookie = await makeUserSession();

	// First: do a valid save to bump the revision to 1
	const r1 = await wikiContentPUT(
		new Request("http://localhost:3000/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ path: "stale.md", content: "# v1\n", baseRevision: 0 }),
		}),
	);
	assert.equal(r1.status, 200);

	// Now try with stale baseRevision 0 again
	const r2 = await wikiContentPUT(
		new Request("http://localhost:3000/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ path: "stale.md", content: "# v2\n", baseRevision: 0 }),
		}),
	);
	assert.equal(r2.status, 409);
	const body = (await r2.json()) as { error: string; currentRevision: number };
	assert.equal(body.error, "STALE_REVISION");
	assert.equal(body.currentRevision, 1);
});

test("PUT /api/wiki/content markdown happy path → 200", async () => {
	const cookie = await makeUserSession();
	const req = new Request("http://localhost:3000/api/wiki/content", {
		method: "PUT",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ path: "happy.md", content: "# Updated\n", baseRevision: 0 }),
	});
	const res = await wikiContentPUT(req);
	assert.equal(res.status, 200);
	const data = (await res.json()) as { ok: boolean; revision: number };
	assert.equal(data.ok, true);
	assert.equal(data.revision, 1);
});

// ─── Response headers ─────────────────────────────────────────────────────────

test("GET /api/wiki/content markdown with auth → X-Wiki-Revision + X-Wiki-Fingerprint", async () => {
	const cookie = await makeUserSession();

	// First write to ensure sidecar exists with revision 1
	await wikiContentPUT(
		new Request("http://localhost:3000/api/wiki/content", {
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ path: "rev-check.md", content: "# Rev v1\n", baseRevision: 0 }),
		}),
	);

	const getReq = new Request(
		"http://localhost:3000/api/wiki/content?path=rev-check.md",
		{ headers: { Cookie: cookie } },
	);
	const res = await wikiContentGET(getReq);
	assert.equal(res.status, 200);

	const revision = res.headers.get("X-Wiki-Revision");
	const fingerprint = res.headers.get("X-Wiki-Fingerprint");
	assert.ok(revision !== null, "X-Wiki-Revision header missing");
	assert.ok(fingerprint !== null, "X-Wiki-Fingerprint header missing");
	assert.equal(revision, "1");
	assert.ok(fingerprint.startsWith("sha256:"), "fingerprint should be sha256:...");
});
