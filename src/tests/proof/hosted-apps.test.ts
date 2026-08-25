/**
 * Hosted apps: registry + management API + slug routing baseline.
 *
 * Exercises the highest external seam (the /api/wiki/hosted-apps HTTP API and
 * the /app/<slug> route) plus the registry module boundary, covering:
 *   - create with a valid slug
 *   - reject duplicate slug (error names owning workspace)
 *   - reject invalid slug format
 *   - reject reserved-name slug
 *   - list returns created entries
 *   - delete removes an entry
 *   - auth/CSRF gate rejects unauthorized and cross-origin state-changing calls
 *   - html slug resolves to dir-served content; unknown slug 404s
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
	DELETE as hostedDELETE,
	GET as hostedGET,
	POST as hostedPOST,
} from "../../app/api/wiki/hosted-apps/route.js";
import { GET as slugGET } from "../../app/app/[slug]/[[...rest]]/route.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace, makeFile } from "./helpers/workspace.js";

let tmpHome: string;
let adminUser: Awaited<ReturnType<typeof makeTestUser>>;
let plainUser: Awaited<ReturnType<typeof makeTestUser>>;
let wsA: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsB: Awaited<ReturnType<typeof createTestWorkspace>>;

function hostedUrl(wsId: string): string {
	return `http://localhost:3000/api/wiki/hosted-apps?ws=${wsId}`;
}

function slugCtx(slug: string, rest: string[] = []) {
	return { params: Promise.resolve({ slug, rest }) };
}

async function clearRegistry() {
	await rm(path.join(tmpHome, ".wiki-viewer", "hosted-apps.json"), {
		force: true,
	});
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";

	adminUser = await makeTestUser({ admin: true });
	plainUser = await makeTestUser();

	wsA = await createTestWorkspace({
		name: "hosted-wsA",
		creatorUserId: adminUser.userId,
		allowedUserIds: [adminUser.userId, plainUser.userId],
	});
	wsB = await createTestWorkspace({
		name: "hosted-wsB",
		creatorUserId: adminUser.userId,
		allowedUserIds: [adminUser.userId],
	});

	// A static HTML site directory in wsA for slug-resolution tests.
	await makeFile(wsA.rootDir, "site/index.html", "<h1>home</h1>");
	await makeFile(wsA.rootDir, "site/style.css", "body{color:red}");
	await makeFile(wsA.rootDir, "site/blog/index.html", "<h1>blog</h1>");
});

beforeEach(clearRegistry);

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	await clearRegistry();
	await rm(wsA.rootDir, { recursive: true, force: true });
	await rm(wsB.rootDir, { recursive: true, force: true });
});

function createReq(
	wsId: string,
	body: Record<string, unknown>,
	cookies: string,
	origin = "http://localhost:3000",
): Request {
	return new Request(hostedUrl(wsId), {
		method: "POST",
		headers: { Cookie: cookies, Origin: origin, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

test("create with a valid slug returns 201", async () => {
	const res = await hostedPOST(
		createReq(wsA.workspace.id, { slug: "my-site", type: "html", path: "site" }, adminUser.cookies),
	);
	assert.equal(res.status, 201);
	const body = (await res.json()) as { app: { slug: string; type: string; workspaceId: string } };
	assert.equal(body.app.slug, "my-site");
	assert.equal(body.app.type, "html");
	assert.equal(body.app.workspaceId, wsA.workspace.id);
});

test("reject duplicate slug and name the owning workspace", async () => {
	await hostedPOST(
		createReq(wsA.workspace.id, { slug: "dup", type: "html", path: "site" }, adminUser.cookies),
	);
	const res = await hostedPOST(
		createReq(wsB.workspace.id, { slug: "dup", type: "html", path: "site" }, adminUser.cookies),
	);
	assert.equal(res.status, 409);
	const body = (await res.json()) as { error: string; message: string };
	assert.equal(body.error, "SLUG_TAKEN");
	assert.ok(
		body.message.includes("hosted-wsA"),
		`duplicate error should name the owning workspace, got: ${body.message}`,
	);
});

test("reject invalid slug format", async () => {
	const res = await hostedPOST(
		createReq(wsA.workspace.id, { slug: "Bad Slug!", type: "html", path: "site" }, adminUser.cookies),
	);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "SLUG_INVALID");
});

test("reject reserved-name slug", async () => {
	const res = await hostedPOST(
		createReq(wsA.workspace.id, { slug: "assets", type: "html", path: "site" }, adminUser.cookies),
	);
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "SLUG_RESERVED");
});

test("list returns created entries", async () => {
	await hostedPOST(
		createReq(wsA.workspace.id, { slug: "one", type: "html", path: "site" }, adminUser.cookies),
	);
	await hostedPOST(
		createReq(wsA.workspace.id, { slug: "two", type: "html", path: "site" }, adminUser.cookies),
	);
	const res = await hostedGET(
		new Request(hostedUrl(wsA.workspace.id), { headers: { Cookie: adminUser.cookies } }),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { apps: Array<{ slug: string }> };
	const slugs = body.apps.map((a) => a.slug).sort();
	assert.deepEqual(slugs, ["one", "two"]);
});

test("delete removes an entry", async () => {
	await hostedPOST(
		createReq(wsA.workspace.id, { slug: "gone", type: "html", path: "site" }, adminUser.cookies),
	);
	const del = await hostedDELETE(
		new Request(hostedUrl(wsA.workspace.id), {
			method: "DELETE",
			headers: {
				Cookie: adminUser.cookies,
				Origin: "http://localhost:3000",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ slug: "gone" }),
		}),
	);
	assert.equal(del.status, 200);
	const res = await hostedGET(
		new Request(hostedUrl(wsA.workspace.id), { headers: { Cookie: adminUser.cookies } }),
	);
	const body = (await res.json()) as { apps: Array<{ slug: string }> };
	assert.equal(body.apps.length, 0);
});

test("unauthenticated create returns 401", async () => {
	const res = await hostedPOST(
		new Request(hostedUrl(wsA.workspace.id), {
			method: "POST",
			headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "nope", type: "html", path: "site" }),
		}),
	);
	assert.equal(res.status, 401);
});

test("cross-origin create is rejected by CSRF gate", async () => {
	const res = await hostedPOST(
		createReq(wsA.workspace.id, { slug: "evil", type: "html", path: "site" }, adminUser.cookies, "http://evil.example"),
	);
	assert.equal(res.status, 403);
});

test("non-admin create is rejected by the app-runner gate", async () => {
	const res = await hostedPOST(
		createReq(wsA.workspace.id, { slug: "plain", type: "html", path: "site" }, plainUser.cookies),
	);
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "ADMIN_REQUIRED");
});

test("html slug resolves to dir-served content", async () => {
	await hostedPOST(
		createReq(wsA.workspace.id, { slug: "site", type: "html", path: "site" }, adminUser.cookies),
	);
	// Note: "site" is not reserved; use it here for a realistic slug.
	const rootReq = new Request("http://localhost:3000/app/site/", {
		headers: { Cookie: adminUser.cookies },
	});
	const rootRes = await slugGET(rootReq, slugCtx("site", []));
	assert.equal(rootRes.status, 200);
	assert.match(await rootRes.text(), /home/);

	// Sub-asset resolves relative to the entry directory.
	const cssReq = new Request("http://localhost:3000/app/site/style.css", {
		headers: { Cookie: adminUser.cookies },
	});
	const cssRes = await slugGET(cssReq, slugCtx("site", ["style.css"]));
	assert.equal(cssRes.status, 200);
	assert.match(await cssRes.text(), /color:red/);

	// Nested directory defaults to its index.html.
	const blogReq = new Request("http://localhost:3000/app/site/blog/", {
		headers: { Cookie: adminUser.cookies },
	});
	const blogRes = await slugGET(blogReq, slugCtx("site", ["blog"]));
	assert.equal(blogRes.status, 200);
	assert.match(await blogRes.text(), /blog/);
});

test("unknown slug returns 404", async () => {
	const req = new Request("http://localhost:3000/app/does-not-exist/", {
		headers: { Cookie: adminUser.cookies },
	});
	const res = await slugGET(req, slugCtx("does-not-exist", []));
	assert.equal(res.status, 404);
});
