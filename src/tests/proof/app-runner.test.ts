/**
 * App runner security and lifecycle baseline.
 *
 * Targets verified high findings:
 *   - app state is keyed only by relPath (no workspace scope)
 *   - any workspace user can launch arbitrary package scripts
 *   - stopApp() leaves the readiness promise alive, so a stopped app can later become error
 *   - runInstall() does not drain stdout/stderr
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile, mkdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { POST as appPOST } from "../../app/api/wiki/app/route.js";
import { startApp, stopApp, getStatus } from "../../lib/app-runner.js";
import { makeTestUser } from "./helpers/session.js";
import { createTestWorkspace } from "./helpers/workspace.js";

let tmpHome: string;
let adminUser: Awaited<ReturnType<typeof makeTestUser>>;
let plainUser: Awaited<ReturnType<typeof makeTestUser>>;
let wsA: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsB: Awaited<ReturnType<typeof createTestWorkspace>>;
let wsApp: Awaited<ReturnType<typeof createTestWorkspace>>;
let appDirA: string;
let appDirB: string;
let crashDir: string;
let installDir: string;

async function waitForRunning(workspaceId: string, relPath: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (getStatus(workspaceId, relPath).status === "running") return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`app ${relPath} in ${workspaceId} never reached running status`);
}

async function writeNodeApp(
	dir: string,
	opts?: { skipInstall?: boolean; crashAfterMs?: number; installMarker?: string; response?: string },
) {
	await mkdir(dir, { recursive: true });
	if (opts?.skipInstall) {
		await mkdir(path.join(dir, "node_modules"), { recursive: true });
	}
	const scripts: Record<string, string> = {};
	if (opts?.installMarker) {
		scripts.install = `node -e "console.log('${opts.installMarker}')"`;
	}
	await writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "fixture-app", main: "server.js", scripts }),
	);
	await writeFile(
		path.join(dir, "server.js"),
		`
const http = require('http');
const portIdx = process.argv.indexOf('--port');
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : process.env.PORT;
const crashAfter = process.env.CRASH_AFTER_MS ? Number(process.env.CRASH_AFTER_MS) : 0;
if (crashAfter) setTimeout(() => process.exit(1), crashAfter);
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(process.env.RESPONSE || 'ok');
});
server.listen(port, '127.0.0.1', () => console.log('fixture up', port));
`.trim(),
	);
}

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";
	process.env.npm_config_offline = "true";
	process.env.npm_config_audit = "false";
	process.env.npm_config_fund = "false";

	adminUser = await makeTestUser({ admin: true });
	plainUser = await makeTestUser();

	wsA = await createTestWorkspace({
		name: "app-runner-wsA",
		creatorUserId: plainUser.userId,
		allowedUserIds: [plainUser.userId],
	});
	wsB = await createTestWorkspace({
		name: "app-runner-wsB",
		creatorUserId: plainUser.userId,
		allowedUserIds: [plainUser.userId],
	});
	wsApp = await createTestWorkspace({
		name: "app-runner-ws",
		creatorUserId: plainUser.userId,
		allowedUserIds: [plainUser.userId],
	});

	appDirA = await mkdtemp(path.join(tmpdir(), "wiki-app-a-"));
	appDirB = await mkdtemp(path.join(tmpdir(), "wiki-app-b-"));
	crashDir = await mkdtemp(path.join(tmpdir(), "wiki-app-crash-"));
	installDir = await mkdtemp(path.join(tmpdir(), "wiki-app-install-"));

	await writeNodeApp(appDirA, { skipInstall: true, response: "app-a" });
	await writeNodeApp(appDirB, { skipInstall: true, response: "app-b" });
	await writeNodeApp(crashDir, { skipInstall: true, crashAfterMs: 200 });
	await writeNodeApp(installDir, { installMarker: "INSTALL-DRAIN-MARKER", response: "installed" });
});

after(async () => {
	delete process.env.AUTH_ALLOWED_DOMAIN;
	delete process.env.CRASH_AFTER_MS;
	delete process.env.RESPONSE;
	stopApp(wsA.workspace.id, "app");
	stopApp(wsB.workspace.id, "app");
	stopApp(wsApp.workspace.id, "appAdmin");
	stopApp(wsApp.workspace.id, "appCrash");
	stopApp(wsApp.workspace.id, "appInstall");
	await rm(tmpHome, { recursive: true, force: true });
	await rm(appDirA, { recursive: true, force: true });
	await rm(appDirB, { recursive: true, force: true });
	await rm(crashDir, { recursive: true, force: true });
	await rm(installDir, { recursive: true, force: true });
});

test("same relPath in two workspaces has independent lifecycle", async () => {
	const first = await startApp(wsA.workspace.id, "app", appDirA);
	await waitForRunning(wsA.workspace.id, "app");

	const second = await startApp(wsB.workspace.id, "app", appDirB);
	assert.notEqual(second.port, first.port, "same relPath in different roots must not collide");

	await waitForRunning(wsB.workspace.id, "app");
	const status = getStatus(wsA.workspace.id, "app");
	assert.equal(status.status, "running");
	assert.ok(status.port);

	stopApp(wsA.workspace.id, "app");
	stopApp(wsB.workspace.id, "app");
});

test("non-admin launch is denied in authenticated mode", async () => {
	const req = new Request(
		`http://localhost:3000/api/wiki/app?ws=${wsApp.workspace.id}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: plainUser.cookies,
				Origin: "http://localhost:3000",
			},
			body: JSON.stringify({ path: "appAdmin" }),
		},
	);
	const res = await appPOST(req);
	assert.equal(res.status, 403, "non-admin app launch must be denied");
	const body = (await res.json()) as { error?: string };
	assert.equal(body.error, "ADMIN_REQUIRED");
});

test("stop cancels readiness: stopped app cannot later become error", async () => {
	process.env.CRASH_AFTER_MS = "200";
	await startApp(wsApp.workspace.id, "appCrash", crashDir);
	stopApp(wsApp.workspace.id, "appCrash");
	await new Promise((r) => setTimeout(r, 800));
	delete process.env.CRASH_AFTER_MS;
	const status = getStatus(wsApp.workspace.id, "appCrash");
	assert.equal(status.status, "stopped", "stopped app must not later become error");
});

test("install output is drained into the app log buffer", async () => {
	await startApp(wsApp.workspace.id, "appInstall", installDir);
	await waitForRunning(wsApp.workspace.id, "appInstall", 12_000);
	const status = getStatus(wsApp.workspace.id, "appInstall");
	const logs = status.logs.join("\n");
	assert.ok(
		logs.includes("INSTALL-DRAIN-MARKER"),
		"install stdout/stderr must be captured in the app log buffer",
	);
	stopApp(wsApp.workspace.id, "appInstall");
});
