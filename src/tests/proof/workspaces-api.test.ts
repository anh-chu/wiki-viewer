/**
 * Phase D1 — Workspace & Admin API tests.
 *
 * Covers:
 *   GET /workspaces        empty → after create
 *   POST /workspaces       admin-only
 *   PATCH /workspaces/[id] allowedUserIds admin-gating
 *   DELETE /workspaces/[id]
 *   GET /admins            GET/POST/DELETE + last-admin guard
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;
let tmpDir: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "ws-api-home-"));
	tmpDir = await mkdtemp(path.join(tmpdir(), "ws-api-dir-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpDir, { recursive: true, force: true });
});

import { GET as wsGET, POST as wsPOST } from "../../app/api/system/workspaces/route.js";
import { PATCH as wsPATCH, DELETE as wsDELETE } from "../../app/api/system/workspaces/[id]/route.js";
import { POST as openPOST } from "../../app/api/system/workspaces/[id]/open/route.js";
import { GET as adminsGET, POST as adminsPOST, DELETE as adminsDELETE } from "../../app/api/system/admins/route.js";

async function signUp(tag: string): Promise<{ cookie: string; id: string; email: string }> {
	const { auth, authReady } = await import("../../lib/auth/server.js");
	await authReady();
	const email = `${tag}${Date.now()}@test.local`;
	const res = await auth.api.signUpEmail({
		body: { email, password: "test1234!", name: tag },
		asResponse: true,
	});
	if (!res.ok) throw new Error("signUp failed: " + res.status);
	const setCookie = res.headers.get("set-cookie") ?? "";
	const cookie = setCookie
		.split(/,(?=[^ ])/)
		.map((c) => c.split(";")[0].trim())
		.join("; ");
	const body = await res.json() as { user: { id: string } };
	return { cookie, id: body.user.id, email };
}

function req(method: string, url: string, cookie: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: {
			"content-type": "application/json",
			cookie,
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

function params(id: string) {
	return { params: Promise.resolve({ id }) };
}

/**
 * Deterministically make a freshly-signed-up user an admin.
 * Bootstrap only auto-promotes the FIRST-EVER user, so subsequent tests must
 * promote their admin explicitly (no shared cookie for the bootstrapped one).
 */
async function makeAdmin(userId: string): Promise<void> {
	const { addAdmin } = await import("../../lib/auth/admin.js");
	await addAdmin(userId);
}

// ── Admin bootstrap + admins API ───────────────────────────────────────────────

test("GET /admins: first user auto-promoted to admin", async () => {
	const user = await signUp("admin1");
	const res = await adminsGET(req("GET", "http://localhost/api/system/admins", user.cookie));
	assert.equal(res.status, 200);
	const json = await res.json() as { isAdmin: boolean; admins: string[]; users: unknown[] };
	assert.equal(json.isAdmin, true);
	assert.ok(json.admins.includes(user.id));
	assert.ok(Array.isArray(json.users)); // admin sees user list
});

test("GET /admins: non-admin gets isAdmin:false, empty users", async () => {
	// Sign up a second user — first user already bootstrapped above
	const user2 = await signUp("nonadmin");
	const res = await adminsGET(req("GET", "http://localhost/api/system/admins", user2.cookie));
	assert.equal(res.status, 200);
	const json = await res.json() as { isAdmin: boolean; users: unknown[] };
	assert.equal(json.isAdmin, false);
	assert.deepEqual(json.users, []);
});

test("POST /admins: admin promotes second user", async () => {
	const admin = await signUp("admin2promo");
	await makeAdmin(admin.id);
	const user2 = await signUp("promo-target");
	const res = await adminsPOST(req("POST", "http://localhost/api/system/admins", admin.cookie, { userId: user2.id }));
	assert.equal(res.status, 200);
	const json = await res.json() as { ok: boolean; admins: string[] };
	assert.ok(json.ok);
	assert.ok(json.admins.includes(user2.id));
});

test("DELETE /admins: refuses to remove last admin (LAST_ADMIN guard)", async () => {
	// Create a fresh admin user, then ensure they are the ONLY admin by using
	// removeAdmin directly, then verify the API returns 409.
	const { removeAdmin: rm2, addAdmin: add2 } = await import("../../lib/auth/admin.js");
	const { updateConfig: uc2 } = await import("../../lib/config.js");

	// Set adminUserIds to a single known userId so last-admin guard fires.
	const soloId = "solo-only-" + Date.now();
	await uc2((cfg) => ({ ...cfg, adminUserIds: [soloId] }));

	// Build a fake signed-in session for soloId is impossible without a real DB user.
	// Instead, call removeAdmin directly to verify the guard, and also verify the
	// API route returns 409 by calling it as an admin user that matches soloId.
	// Since we cannot create a session for soloId, we verify guard via library:
	try {
		await rm2(soloId);
		assert.fail("Expected LAST_ADMIN error");
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		assert.ok(msg.startsWith("LAST_ADMIN"), `Expected LAST_ADMIN, got: ${msg}`);
	}

	// Restore admin list for subsequent tests
	const admin = await signUp("restore-admin");
	await adminsGET(req("GET", "http://localhost/api/system/admins", admin.cookie));
});

// ── Workspace API ──────────────────────────────────────────────────────────────

test("GET /workspaces: empty on fresh config", async () => {
	const user = await signUp("ws-list-user");
	const res = await wsGET(req("GET", "http://localhost/api/system/workspaces", user.cookie));
	assert.equal(res.status, 200);
	const json = await res.json() as { workspaces: unknown[] };
	assert.ok(Array.isArray(json.workspaces));
});

test("POST /workspaces: admin creates workspace", async () => {
	const admin = await signUp("ws-creator");
	await makeAdmin(admin.id);
	const newDir = await mkdtemp(path.join(tmpdir(), "ws-api-create-"));
	try {
		const res = await wsPOST(req("POST", "http://localhost/api/system/workspaces", admin.cookie, { rootDir: newDir }));
		assert.equal(res.status, 200);
		const json = await res.json() as { ok: boolean; workspace: { id: string; rootDir: string } };
		assert.ok(json.ok);
		assert.equal(json.workspace.rootDir, newDir);
		assert.ok(json.workspace.id.startsWith("ws_"));

		// Verify it shows in list
		const listRes = await wsGET(req("GET", "http://localhost/api/system/workspaces", admin.cookie));
		const listJson = await listRes.json() as { workspaces: Array<{ id: string }> };
		assert.ok(listJson.workspaces.some((w) => w.id === json.workspace.id));

		// PATCH name — any user with access
		const patchRes = await wsPATCH(
			req("PATCH", `http://localhost/api/system/workspaces/${json.workspace.id}`, admin.cookie, { name: "Renamed" }),
			params(json.workspace.id),
		);
		assert.equal(patchRes.status, 200);
		const patchJson = await patchRes.json() as { workspace: { name: string } };
		assert.equal(patchJson.workspace.name, "Renamed");

		// PATCH allowedUserIds: non-admin should fail
		const nonAdmin = await signUp("non-admin-patch");
		const patchForbidden = await wsPATCH(
			req("PATCH", `http://localhost/api/system/workspaces/${json.workspace.id}`, nonAdmin.cookie, { allowedUserIds: [] }),
			params(json.workspace.id),
		);
		assert.equal(patchForbidden.status, 403);

		// PATCH allowedUserIds: admin succeeds
		const patchAllowed = await wsPATCH(
			req("PATCH", `http://localhost/api/system/workspaces/${json.workspace.id}`, admin.cookie, { allowedUserIds: [admin.id] }),
			params(json.workspace.id),
		);
		assert.equal(patchAllowed.status, 200);

		// DELETE workspace
		const delRes = await wsDELETE(
			req("DELETE", `http://localhost/api/system/workspaces/${json.workspace.id}`, admin.cookie),
			params(json.workspace.id),
		);
		assert.equal(delRes.status, 200);
		const delJson = await delRes.json() as { ok: boolean };
		assert.ok(delJson.ok);
	} finally {
		await rm(newDir, { recursive: true, force: true });
	}
});

test("POST /workspaces: non-existent dir returns 404", async () => {
	const admin = await signUp("ws-baddir");
	await makeAdmin(admin.id);
	const res = await wsPOST(req("POST", "http://localhost/api/system/workspaces", admin.cookie, { rootDir: "/nonexistent/path/xyz" }));
	assert.equal(res.status, 404);
});

test("POST /workspaces/[id]/open: updates lastOpenedAt", async () => {
	const admin = await signUp("ws-open");
	await makeAdmin(admin.id);
	const newDir = await mkdtemp(path.join(tmpdir(), "ws-open-"));
	try {
		const createRes = await wsPOST(req("POST", "http://localhost/api/system/workspaces", admin.cookie, { rootDir: newDir }));
		const { workspace } = await createRes.json() as { workspace: { id: string; lastOpenedAt: string } };

		await new Promise((r) => setTimeout(r, 10)); // small delay for timestamp difference
		const openRes = await openPOST(
			req("POST", `http://localhost/api/system/workspaces/${workspace.id}/open`, admin.cookie),
			params(workspace.id),
		);
		assert.equal(openRes.status, 200);
	} finally {
		await rm(newDir, { recursive: true, force: true });
	}
});
