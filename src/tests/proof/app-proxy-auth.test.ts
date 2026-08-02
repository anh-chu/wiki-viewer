/**
 * App proxy authentication and isolation baseline.
 *
 * Targets verified critical/high findings:
 *   - /api/app-proxy is unauthenticated
 *   - app runner state is keyed only by relPath (no workspace scope)
 *   - upstream requests currently carry wiki session credentials
 */
import { test, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GET as proxyGET } from "../../app/api/app-proxy/[...path]/route.js";
import { startApp, stopApp, getStatus } from "../../lib/app-runner.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace } from "./helpers/workspace.js";

let tmpHome: string;
let user1: Awaited<ReturnType<typeof makeTestUser>>;
let user2: Awaited<ReturnType<typeof makeTestUser>>;
let wsA: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsB: Awaited<ReturnType<typeof createTestWorkspace>>;
let appDirA: string;

function ctx(segments: string[]) {
	return { params: Promise.resolve({ path: segments }) };
}

async function waitForRunning(workspaceId: string, relPath: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getStatus(workspaceId, relPath).status === "running") return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`app ${relPath} in ${workspaceId} never reached running status`);
}

async function writeFixtureApp(dir: string) {
	await mkdir(dir, { recursive: true });
	await mkdir(path.join(dir, "node_modules"), { recursive: true });
	await writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture-app", main: "server.js" }),
	);
	await writeFile(
		path.join(dir, "server.js"),
		`
const http = require('http');
const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : process.env.PORT;
const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (pathname === '/index') { res.writeHead(200); res.end('hello'); return; }
  if (pathname === '/headers') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      agent: req.headers['x-agent-id'],
      origin: req.headers.origin,
      workspace: req.headers['x-workspace'],
    }));
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(port, '127.0.0.1', () => console.log('fixture up', port));
`.trim(),
	);
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";

	user1 = await makeTestUser();
	user2 = await makeTestUser();

	wsA = await createTestWorkspace({
		name: "proxy-wsA",
		creatorUserId: user1.userId,
		allowedUserIds: [user1.userId],
	});
	wsB = await createTestWorkspace({
		name: "proxy-wsB",
		creatorUserId: user2.userId,
		allowedUserIds: [user2.userId],
	});

	appDirA = await mkdtemp(path.join(tmpdir(), "wiki-app-a-"));
	await writeFixtureApp(appDirA);
});

beforeEach(async () => {
	const { Agent, setGlobalDispatcher } = await import("undici");
	setGlobalDispatcher(new Agent());
});

afterEach(async () => {
	stopApp(wsA.workspace.id, "app");
	try {
		const { getGlobalDispatcher } = await import("undici");
		await getGlobalDispatcher().close();
	} catch {
		// ignore
	}
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	stopApp(wsA.workspace.id, "app");
	await rm(tmpHome, { recursive: true, force: true });
	await rm(wsA.rootDir, { recursive: true, force: true });
	await rm(wsB.rootDir, { recursive: true, force: true });
	await rm(appDirA, { recursive: true, force: true });
});

test("unauthenticated proxy request returns 401 before upstream", async () => {
	const req = new Request("http://localhost:3000/api/app-proxy/app/index");
	const res = await proxyGET(req, ctx(["app", "index"]));
	assert.equal(res.status, 401, "proxy must authenticate before upstream");
});

test("authenticated request cannot see an app registered in another workspace", async () => {
	await startApp(wsA.workspace.id, "app", appDirA);
	await waitForRunning(wsA.workspace.id, "app");

	const req = new Request(
		`http://localhost:3000/api/app-proxy/app/missing?ws=${wsB.workspace.id}`,
		{ headers: { Cookie: user1.cookies } },
	);
	const res = await proxyGET(req, ctx(["app", "missing"]));
	assert.ok(
		res.status === 403 || res.status === 404,
		"app must be scoped to the requested workspace",
	);
	const ct = res.headers.get("content-type") ?? "";
	assert.ok(
		ct.includes("application/json"),
		"cross-workspace proxy must fail inside wiki, not forward upstream",
	);
});

test("forwarded upstream headers omit wiki credentials", async () => {
	await startApp(wsA.workspace.id, "app", appDirA);
	await waitForRunning(wsA.workspace.id, "app");

	const req = new Request(
		`http://localhost:3000/api/app-proxy/app/headers?ws=${wsA.workspace.id}`,
		{
			headers: {
				Cookie: user1.cookies,
				Authorization: "Bearer wiki-token",
				"X-Agent-Id": "agent-1",
				"X-Workspace": wsA.workspace.id,
				Origin: "http://localhost:3000",
			},
		},
	);
	const res = await proxyGET(req, ctx(["app", "headers"]));
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		cookie?: string;
		authorization?: string;
		agent?: string;
		origin?: string;
		workspace?: string;
	};
	assert.equal(body.cookie, undefined, "cookie must be stripped");
	assert.equal(body.authorization, undefined, "authorization must be stripped");
	assert.equal(body.agent, undefined, "x-agent-id must be stripped");
	assert.equal(body.workspace, undefined, "x-workspace must be stripped");
});

test("same-workspace proxy request succeeds", async () => {
	await startApp(wsA.workspace.id, "app", appDirA);
	await waitForRunning(wsA.workspace.id, "app");

	const req = new Request(
		`http://localhost:3000/api/app-proxy/app/index?ws=${wsA.workspace.id}`,
		{ headers: { Cookie: user1.cookies } },
	);
	const res = await proxyGET(req, ctx(["app", "index"]));
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "hello");
});
