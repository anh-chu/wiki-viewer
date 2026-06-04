/**
 * Phase C — Agent workspace scoping.
 *
 * Proves an agent whose scope.workspaceId is pinned to one workspace is
 * rejected (403) when a request resolves to a DIFFERENT workspace, and
 * allowed (200) when it matches. An agent with no workspaceId (wildcard)
 * works in any workspace.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { setRootDir } from "../../lib/root-dir.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { writeConfig } from "../../lib/config.js";
import type { Workspace } from "../../lib/workspaces.js";

let tmpHome: string;
let rootA: string;
let rootB: string;
let wsA: Workspace;
let wsB: Workspace;

let fileGET: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

const PINNED_TOKEN = randomBytes(32).toString("hex");
const WILDCARD_TOKEN = randomBytes(32).toString("hex");

function headers(token: string, id: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "X-Agent-Id": id };
}

function makeCtx(segments: string[]): { params: Promise<{ path: string[] }> } {
	return { params: Promise.resolve({ path: segments }) };
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "ws-scope-home-"));
	rootA = await mkdtemp(path.join(tmpdir(), "ws-scope-A-"));
	rootB = await mkdtemp(path.join(tmpdir(), "ws-scope-B-"));
	process.env.HOME = tmpHome;
	setRootDir(rootA); // fallback (unused once registry has workspaces)

	wsA = {
		id: "ws_AAAAAA",
		name: "A",
		rootDir: rootA,
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
	};
	wsB = {
		id: "ws_BBBBBB",
		name: "B",
		rootDir: rootB,
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
	};
	// Seed registry so resolveWorkspaceForAgent picks by ?ws= instead of fallback.
	await writeConfig({ workspaces: [wsA, wsB] });

	await ensureRegistry();
	await addAgent({
		id: "ai:pinned",
		displayName: "Pinned to A",
		tokenHash: hashToken(PINNED_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"], workspaceId: wsA.id },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});
	await addAgent({
		id: "ai:wildcard",
		displayName: "Wildcard",
		tokenHash: hashToken(WILDCARD_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] }, // no workspaceId
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await writeFile(path.join(rootA, "a.txt"), "in A");
	await writeFile(path.join(rootB, "b.txt"), "in B");

	const fileRoute = await import("../../app/api/agent/fs/file/[...path]/route.js");
	fileGET = fileRoute.GET;
});

async function rmQuiet(p: string): Promise<void> {
	// File-lock sentinels may be written concurrently during teardown → retry.
	for (let i = 0; i < 3; i++) {
		try {
			await rm(p, { recursive: true, force: true });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
}

after(async () => {
	await rmQuiet(tmpHome);
	await rmQuiet(rootA);
	await rmQuiet(rootB);
});

test("pinned agent: 200 in its own workspace", async () => {
	const req = new Request(`http://localhost/api/agent/fs/file/a.txt?ws=${wsA.id}`, {
		headers: headers(PINNED_TOKEN, "ai:pinned"),
	});
	const res = await fileGET(req, makeCtx(["a.txt"]));
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "in A");
});

test("pinned agent: 403 when request resolves to a different workspace", async () => {
	const req = new Request(`http://localhost/api/agent/fs/file/b.txt?ws=${wsB.id}`, {
		headers: headers(PINNED_TOKEN, "ai:pinned"),
	});
	const res = await fileGET(req, makeCtx(["b.txt"]));
	assert.equal(res.status, 403);
});

test("wildcard agent: 200 in either workspace", async () => {
	const reqA = new Request(`http://localhost/api/agent/fs/file/a.txt?ws=${wsA.id}`, {
		headers: headers(WILDCARD_TOKEN, "ai:wildcard"),
	});
	assert.equal((await fileGET(reqA, makeCtx(["a.txt"]))).status, 200);

	const reqB = new Request(`http://localhost/api/agent/fs/file/b.txt?ws=${wsB.id}`, {
		headers: headers(WILDCARD_TOKEN, "ai:wildcard"),
	});
	assert.equal((await fileGET(reqB, makeCtx(["b.txt"]))).status, 200);
});
