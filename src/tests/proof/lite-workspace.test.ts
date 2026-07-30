/**
 * lite-workspace.test.ts — WIKI_LITE=1 workspace resolution.
 *
 * Contract:
 *   - With WIKI_LITE=1 and no root, pickWorkspace returns code root_required.
 *   - With WIKI_LITE=1 and a valid root, pickWorkspace yields the ephemeral workspace.
 *   - config.json is never created when WIKI_LITE=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import { resolveWorkspaceForAgent } from "../../lib/workspace-context.js";

let tmpHome: string;
let rootDir: string;
const savedLite = process.env.WIKI_LITE;
const savedHome = process.env.HOME;
const savedNoAuth = process.env.WIKI_NO_AUTH;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "lite-ws-home-"));
	process.env.HOME = tmpHome;
	process.env.WIKI_LITE = "1";
	process.env.WIKI_NO_AUTH = "1";

	rootDir = await mkdtemp(path.join(tmpdir(), "lite-ws-root-"));
	await writeFile(path.join(rootDir, "test.md"), "# lite test\n");
});

after(async () => {
	if (savedLite === undefined) delete process.env.WIKI_LITE;
	else process.env.WIKI_LITE = savedLite;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = savedNoAuth;
	await rm(tmpHome, { recursive: true, force: true });
	await rm(rootDir, { recursive: true, force: true });
});

function req(url: string): Request {
	return new Request(url);
}

test("WIKI_LITE=1 without root -> root_required", async () => {
	const res = await resolveWorkspaceForAgent(
		req("http://localhost:3000/api/wiki"),
	);
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.equal(res.code, "root_required");
	assert.equal(res.status, 400);
});

test("WIKI_LITE=1 with valid root -> ephemeral workspace", async () => {
	const res = await resolveWorkspaceForAgent(
		req(`http://localhost:3000/api/wiki?root=${encodeURIComponent(rootDir)}`),
	);
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.equal(res.rootDir, path.resolve(rootDir));
	assert.equal(res.ws.ephemeral, true);
});

test("WIKI_LITE=1 never creates config.json", async () => {
	// Ensure no .wiki-viewer directory or config.json is created.
	const cfgDir = path.join(tmpHome, ".wiki-viewer");
	const cfgFile = path.join(cfgDir, "config.json");

	// Run resolution twice (migration runs on first call in a process).
	await resolveWorkspaceForAgent(
		req(`http://localhost:3000/api/wiki?root=${encodeURIComponent(rootDir)}`),
	);

	assert.equal(
		existsSync(cfgFile),
		false,
		"config.json must not be created in lite mode",
	);
});
