import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { resolveHostedTarget } from "../../lib/hosted-apps-resolve.js";
import { createHostedApp } from "../../lib/hosted-apps.js";

let tmpHome: string;

before(async () => {
	tmpHome = process.env.WIKI_TEST_HOME!;
});

beforeEach(async () => {
	await rm(path.join(tmpHome, ".wiki-viewer", "hosted-apps.json"), { force: true });
});

after(async () => {
	await rm(path.join(tmpHome, ".wiki-viewer", "hosted-apps.json"), { force: true });
});

test("node slug resolves to workspace path and live stopped status", async () => {
	const created = await createHostedApp({
		slug: "node-site",
		type: "node",
		workspaceId: "workspace-node",
		relPath: "apps/site",
		script: "dev",
	});
	assert.equal(created.ok, true);

	const target = await resolveHostedTarget("node-site");
	assert.ok(target);
	assert.equal(target.kind, "node");
	assert.equal(target.workspaceId, "workspace-node");
	assert.equal(target.relPath, "apps/site");
	assert.equal(target.status, "stopped");
	assert.equal(target.port, undefined);
});

test("unknown hosted slug does not resolve", async () => {
	assert.equal(await resolveHostedTarget("missing-node"), null);
});
