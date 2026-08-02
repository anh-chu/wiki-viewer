/**
 * Protected public share baseline.
 *
 * Targets verified high findings:
 *   - protected binary assets fail because the asset route expects password in URL
 *   - there is no cookie-based unlock grant
 *   - protected content is currently cached as public
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";

import { GET as shareContentGET, POST as shareContentPOST } from "../../app/api/share/[token]/route.js";
import { GET as shareAssetGET } from "../../app/api/share/[token]/asset/route.js";
import { createShare, _resetSharedDb } from "../../lib/shared-docs/db.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace, makeFile } from "./helpers/workspace.js";

let tmpHome: string;
let user: Awaited<ReturnType<typeof makeTestUser>>;
let ws: Awaited<ReturnType<typeof createTestWorkspace>>;
let textShare: Awaited<ReturnType<typeof createShare>>;
let binaryShare: Awaited<ReturnType<typeof createShare>>;
const PASSWORD = "share-password-123";
const BINARY_BYTES = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52,
]);

function ctx(token: string) {
	return { params: Promise.resolve({ token }) };
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";
	_resetSharedDb();

	user = await makeTestUser();
	ws = await createTestWorkspace({
		name: "share-ws",
		creatorUserId: user.userId,
		allowedUserIds: [user.userId],
	});

	await makeFile(ws.rootDir, "shared.md", "# Shared document\n");
	await makeFile(ws.rootDir, "asset.png", BINARY_BYTES);

	textShare = createShare({
		workspaceId: ws.workspace.id,
		filePath: "shared.md",
		password: PASSWORD,
		createdBy: user.userId,
	});
	binaryShare = createShare({
		workspaceId: ws.workspace.id,
		filePath: "asset.png",
		password: PASSWORD,
		createdBy: user.userId,
	});
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	_resetSharedDb();
	await rm(tmpHome, { recursive: true, force: true });
	await rm(ws.rootDir, { recursive: true, force: true });
});

// ─── Unlock and cookie contract ──────────────────────────────────────────────

test("password unlock returns content and sets a scoped HttpOnly cookie", async () => {
	const req = new Request(
		`http://localhost:3000/api/share/${textShare.token}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: PASSWORD }),
		},
	);
	const res = await shareContentPOST(req, ctx(textShare.token));
	assert.equal(res.status, 200);

	const body = (await res.json()) as { content: string };
	assert.ok(body.content.includes("Shared document"));

	const setCookie = res.headers.get("set-cookie") ?? "";
	assert.ok(setCookie.includes("HttpOnly"), "unlock cookie must be HttpOnly");
	assert.ok(
		setCookie.includes(`Path=/api/share/${textShare.token}`),
		"unlock cookie must be scoped to the share asset route",
	);
	assert.ok(
		setCookie.includes("SameSite="),
		"unlock cookie must carry SameSite protection",
	);
});

// ─── Asset access without password-in-URL ────────────────────────────────────

test("protected binary asset works after unlock without password in URL", async () => {
	// 1. Unlock via the content route to obtain the grant cookie.
	const unlockReq = new Request(
		`http://localhost:3000/api/share/${binaryShare.token}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: PASSWORD }),
		},
	);
	const unlockRes = await shareContentPOST(unlockReq, ctx(binaryShare.token));
	assert.equal(unlockRes.status, 200);
	const cookie = unlockRes.headers.get("set-cookie") ?? "";
	assert.ok(cookie, "unlock must set a cookie");

	// 2. Fetch the asset with the cookie and no query password.
	const assetReq = new Request(
		`http://localhost:3000/api/share/${binaryShare.token}/asset`,
		{ headers: { Cookie: cookie } },
	);
	const assetRes = await shareAssetGET(assetReq, ctx(binaryShare.token));
	assert.equal(
		assetRes.status,
		200,
		"protected asset must be readable with a valid cookie",
	);

	const body = Buffer.from(await assetRes.arrayBuffer());
	assert.deepEqual(body, BINARY_BYTES);
});

test("protected asset Cache-Control is private, no-store", async () => {
	const unlockReq = new Request(
		`http://localhost:3000/api/share/${binaryShare.token}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: PASSWORD }),
		},
	);
	const unlockRes = await shareContentPOST(unlockReq, ctx(binaryShare.token));
	assert.equal(unlockRes.status, 200);
	const cookie = unlockRes.headers.get("set-cookie") ?? "";

	const assetReq = new Request(
		`http://localhost:3000/api/share/${binaryShare.token}/asset`,
		{ headers: { Cookie: cookie } },
	);
	const assetRes = await shareAssetGET(assetReq, ctx(binaryShare.token));
	const cc = assetRes.headers.get("Cache-Control") ?? "";
	assert.ok(cc.includes("private"), "protected asset must be private");
	assert.ok(cc.includes("no-store"), "protected asset must not be stored");
});

// ─── Auth errors and wrong password ──────────────────────────────────────────

test("unauthenticated protected asset request is denied", async () => {
	const req = new Request(
		`http://localhost:3000/api/share/${binaryShare.token}/asset`,
	);
	const res = await shareAssetGET(req, ctx(binaryShare.token));
	assert.equal(res.status, 401);
});

test("protected content GET without unlock is denied", async () => {
	const req = new Request(
		`http://localhost:3000/api/share/${textShare.token}`,
	);
	const res = await shareContentGET(req, ctx(textShare.token));
	assert.equal(res.status, 401);
	const body = (await res.json()) as { protected?: boolean };
	assert.equal(body.protected, true);
});

test("wrong password is rejected", async () => {
	const req = new Request(
		`http://localhost:3000/api/share/${textShare.token}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ password: "wrong" }),
		},
	);
	const res = await shareContentPOST(req, ctx(textShare.token));
	assert.equal(res.status, 403);
});
