/**
 * Browser file endpoint security baseline.
 *
 * Targets verified critical/high findings:
 *   - /api/assets, /api/upload, /api/wiki/file bypass authentication
 *   - /api/upload is not CSRF-protected
 *   - workspace ACLs are not enforced on browser file routes
 *   - symlink escapes and read-only workspace write attempts
 *
 * Current implementation is expected to fail the auth/CSRF/ACL cases.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, symlink, writeFile, mkdir, mkdtemp, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GET as assetGET } from "../../app/api/assets/[...path]/route.js";
import { POST as uploadPOST } from "../../app/api/upload/[...path]/route.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace, makeFile } from "./helpers/workspace.js";

let tmpHome: string;
let outsideDir: string;
let user1: Awaited<ReturnType<typeof makeTestUser>>;
let user2: Awaited<ReturnType<typeof makeTestUser>>;
let wsA: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsB: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsRead: Awaited<ReturnType<typeof createTestWorkspace>>;
let apiKey: string;

function ctx(segments: string[]) {
	return { params: Promise.resolve({ path: segments }) };
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";

	user1 = await makeTestUser();
	user2 = await makeTestUser();

	wsA = await createTestWorkspace({
		name: "wsA",
		creatorUserId: user1.userId,
		allowedUserIds: [user1.userId],
	});
	wsB = await createTestWorkspace({
		name: "wsB",
		creatorUserId: user2.userId,
		allowedUserIds: [user2.userId],
	});
	wsRead = await createTestWorkspace({
		name: "wsRead",
		creatorUserId: user1.userId,
		allowedUserIds: [user1.userId],
		readOnly: true,
	});

	outsideDir = await mkdtemp(path.join(tmpdir(), "wiki-outside-"));
	await writeFile(path.join(outsideDir, "secret.txt"), "outside-secret");

	await makeFile(wsA.rootDir, "readable.txt", "workspace-a-secret");
	await makeFile(wsB.rootDir, "readable.txt", "workspace-b-secret");
	await symlink(outsideDir, path.join(wsA.rootDir, "escape-link"));

	// Make wsA the default workspace for unauthenticated requests.
	const { touchWorkspace } = await import("../../lib/workspaces.js");
	await touchWorkspace(wsA.workspace.id);

	const { ensureApiKey } = await import("../../lib/auth/api-key.js");
	apiKey = ensureApiKey();
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	await rm(tmpHome, { recursive: true, force: true });
	await rm(wsA.rootDir, { recursive: true, force: true });
	await rm(wsB.rootDir, { recursive: true, force: true });
	await rm(wsRead.rootDir, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
});

// ─── Authentication bypasses ─────────────────────────────────────────────────

test("GET /api/assets without session → 401", async () => {
	const req = new Request(
		`http://localhost:3000/api/assets/readable.txt?ws=${wsA.workspace.id}`,
	);
	const res = await assetGET(req, ctx(["readable.txt"]));
	assert.equal(res.status, 401, "unauthenticated asset read must be rejected");
});

test("GET /api/wiki/file (dead route) moved to /api/assets → 401", async () => {
	const req = new Request(
		`http://localhost:3000/api/assets/readable.txt?ws=${wsA.workspace.id}`,
	);
	const res = await assetGET(req, ctx(["readable.txt"]));
	assert.equal(res.status, 401, "unauthenticated asset read must be rejected");
});

test("POST /api/upload without session → 401", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/note.md?ws=${wsA.workspace.id}`,
		{ method: "POST", body: form },
	);
	const res = await uploadPOST(req, ctx(["note.md"]));
	assert.equal(res.status, 401, "unauthenticated upload must be rejected");
});

// ─── Cross-origin write protection ───────────────────────────────────────────

test("POST /api/upload with valid session + evil origin → 403", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/note.md?ws=${wsA.workspace.id}`,
		{
			method: "POST",
			headers: { Cookie: user1.cookies, Origin: "https://evil.com" },
			body: form,
		},
	);
	const res = await uploadPOST(req, ctx(["note.md"]));
	assert.equal(res.status, 403, "cross-origin upload must be rejected");
});

// ─── Workspace ACLs ──────────────────────────────────────────────────────────

test("GET /api/assets in a workspace the user cannot access → 403", async () => {
	const req = new Request(
		`http://localhost:3000/api/assets/readable.txt?ws=${wsB.workspace.id}`,
		{ headers: { Cookie: user1.cookies } },
	);
	const res = await assetGET(req, ctx(["readable.txt"]));
	assert.equal(res.status, 403, "workspace ACL must deny cross-workspace reads");
});

test("POST /api/upload to read-only workspace → 403 WORKSPACE_READ_ONLY", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/note.md?ws=${wsRead.workspace.id}`,
		{ method: "POST", headers: { Cookie: user1.cookies }, body: form },
	);
	const res = await uploadPOST(req, ctx(["note.md"]));
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error?: string };
	assert.equal(body.error, "WORKSPACE_READ_ONLY");
});

// ─── Path containment ────────────────────────────────────────────────────────

test("GET /api/assets through symlink pointing outside root → 400", async () => {
	const req = new Request(
		`http://localhost:3000/api/assets/escape-link/secret.txt?ws=${wsA.workspace.id}`,
		{ headers: { Cookie: user1.cookies } },
	);
	const res = await assetGET(req, ctx(["escape-link", "secret.txt"]));
	assert.equal(res.status, 400, "symlink escape must be rejected");
});

test("POST /api/upload through symlink pointing outside root → 400 and does not write", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/escape-link?ws=${wsA.workspace.id}`,
		{ method: "POST", headers: { Cookie: user1.cookies }, body: form },
	);
	const res = await uploadPOST(req, ctx(["escape-link"]));
	assert.equal(res.status, 400, "upload symlink escape must be rejected");
	// Ensure nothing leaked into the outside directory.
	const outside = await readdir(outsideDir);
	assert.deepEqual(outside, ["secret.txt"], "outside directory must be untouched");
});

test("POST /api/upload nested path through symlink → 400", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/escape-link/new/file.md?ws=${wsA.workspace.id}`,
		{ method: "POST", headers: { Cookie: user1.cookies }, body: form },
	);
	const res = await uploadPOST(req, ctx(["escape-link", "new", "file.md"]));
	assert.equal(res.status, 400, "nested symlink create must be rejected");
	await assert.rejects(
		access(path.join(outsideDir, "new")),
		{ code: "ENOENT" },
	);
});

// ─── Existing legitimate API-key ephemeral root still works ──────────────────

test("GET /api/assets with API-key ephemeral root succeeds", async () => {
	const req = new Request(
		`http://localhost:3000/api/assets/readable.txt?root=${encodeURIComponent(wsA.rootDir)}`,
		{ headers: { Authorization: `Bearer ${apiKey}` } },
	);
	const res = await assetGET(req, ctx(["readable.txt"]));
	assert.equal(res.status, 200, "api-key ephemeral root must still work");
});

// ─── Response must not expose host paths ─────────────────────────────────────

test("POST /api/upload does not return absolutePath", async () => {
	const form = new FormData();
	form.append("file", new File([Buffer.from("x")], "x.txt", { type: "text/plain" }));
	const req = new Request(
		`http://localhost:3000/api/upload/note.md?ws=${wsA.workspace.id}`,
		{ method: "POST", headers: { Cookie: user1.cookies }, body: form },
	);
	const res = await uploadPOST(req, ctx(["note.md"]));
	if (res.status === 200) {
		const body = (await res.json()) as { absolutePath?: string };
		assert.equal(
			body.absolutePath,
			undefined,
			"upload response must not leak absolutePath",
		);
	}
});
