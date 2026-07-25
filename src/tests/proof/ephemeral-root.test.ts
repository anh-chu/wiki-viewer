/**
 * Request-scoped ephemeral root (?root=) for embedding hosts (termyard).
 *
 * Contract under test:
 *   - `root` is honored ONLY for API-key-authenticated requests, never on the
 *     strength of `?embed=1` or an ordinary session.
 *   - Failures are LOUD (400 + machine-readable code), never a silent fallback
 *     to the default workspace.
 *   - The supplied root NEVER enters the workspace registry.
 *   - Concurrent requests with different roots do not interfere.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveWorkspaceForAgent } from "../../lib/workspace-context.js";
import { ensureApiKey, EMBED_COOKIE_NAME } from "../../lib/auth/api-key.js";
import { createWorkspace, listWorkspaces } from "../../lib/workspaces.js";

let rootA: string;
let rootB: string;
let registered: string;
let aFile: string;
let API_KEY: string;
const savedNoAuth = process.env.WIKI_NO_AUTH;

before(async () => {
	// These tests assert the real gate, so the blanket dev bypass must be off.
	delete process.env.WIKI_NO_AUTH;

	rootA = await mkdtemp(path.join(tmpdir(), "eph-A-"));
	rootB = await mkdtemp(path.join(tmpdir(), "eph-B-"));
	registered = await mkdtemp(path.join(tmpdir(), "eph-reg-"));
	aFile = path.join(rootA, "a-file.md");
	await writeFile(aFile, "# hi\n");

	API_KEY = ensureApiKey();

	// A real registry workspace so we can prove the ephemeral root never joins it
	// and that non-root resolution still works.
	await createWorkspace({ rootDir: registered, createdBy: "test" });
});

after(async () => {
	if (savedNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = savedNoAuth;
	await rm(rootA, { recursive: true, force: true });
	await rm(rootB, { recursive: true, force: true });
	await rm(registered, { recursive: true, force: true });
});

function reqWith(
	url: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(url, { headers });
}

const BASE = "http://localhost:3000/api/wiki/file";

test("root honored with a valid Bearer API key", async () => {
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(rootA)}`, {
			authorization: `Bearer ${API_KEY}`,
		}),
	);
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.rootDir, path.resolve(rootA));
	assert.equal(res.ws.ephemeral, true);
});

test("root honored via embed cookie even when a session cookie precedes it", async () => {
	// Regression guard for the `;s*` vs `;\\s*` cookie-regex bug: cookies are
	// separated by "; ", and the embed cookie is commonly NOT first because the
	// user also has wiki-viewer open standalone.
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(rootA)}`, {
			cookie: `better-auth.session_token=abc123; ${EMBED_COOKIE_NAME}=${API_KEY}`,
		}),
	);
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.rootDir, path.resolve(rootA));
});

test("root REJECTED with no credentials (loud, not silent fallback)", async () => {
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(rootA)}`),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.status, 400);
	assert.equal(res.code, "root_requires_api_key");
});

test("root REJECTED with an invalid key", async () => {
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(rootA)}`, {
			authorization: `Bearer ${"0".repeat(64)}`,
		}),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.code, "root_requires_api_key");
});

test("embed=1 alone does NOT unlock root", async () => {
	// The whole point of the api-key gate: embed=1 is attacker-controlled.
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?embed=1&root=${encodeURIComponent(rootA)}`),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.code, "root_requires_api_key");
});

test("root pointing at a file returns root_not_a_directory", async () => {
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(aFile)}`, {
			authorization: `Bearer ${API_KEY}`,
		}),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.status, 400);
	assert.equal(res.code, "root_not_a_directory");
});

test("nonexistent root returns root_not_found", async () => {
	const missing = path.join(rootA, "definitely", "not", "here");
	const res = await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(missing)}`, {
			authorization: `Bearer ${API_KEY}`,
		}),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.status, 400);
	assert.equal(res.code, "root_not_found");
});

test("ephemeral root never enters the workspace registry", async () => {
	const before = await listWorkspaces();
	await resolveWorkspaceForAgent(
		reqWith(`${BASE}?root=${encodeURIComponent(rootB)}`, {
			authorization: `Bearer ${API_KEY}`,
		}),
	);
	const after = await listWorkspaces();
	assert.equal(after.length, before.length);
	assert.equal(
		after.some((w) => w.rootDir === path.resolve(rootB)),
		false,
		"host-supplied root must never be registered",
	);
});

test("concurrent requests with different roots do not interfere", async () => {
	const [a, b] = await Promise.all([
		resolveWorkspaceForAgent(
			reqWith(`${BASE}?root=${encodeURIComponent(rootA)}`, {
				authorization: `Bearer ${API_KEY}`,
			}),
		),
		resolveWorkspaceForAgent(
			reqWith(`${BASE}?root=${encodeURIComponent(rootB)}`, {
				authorization: `Bearer ${API_KEY}`,
			}),
		),
	]);
	assert.equal(a.ok && b.ok, true);
	if (!a.ok || !b.ok) return;
	assert.equal(a.rootDir, path.resolve(rootA));
	assert.equal(b.rootDir, path.resolve(rootB));
	assert.notEqual(a.ws.id, b.ws.id);
});

test("no root param -> unchanged registry resolution, not ephemeral", async () => {
	const res = await resolveWorkspaceForAgent(reqWith(BASE));
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.notEqual(res.ws.ephemeral, true);
	assert.equal(res.rootDir, path.resolve(registered));
});
