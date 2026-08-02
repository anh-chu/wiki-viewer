import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeWorkspace } from "../../lib/workspaces.js";
import type { Workspace } from "../../lib/workspaces.js";

test("sanitizeWorkspace strips tokenRef and secretRef from response shapes", () => {
	const ws: Workspace = {
		id: "ws_test001",
		name: "Secret Test",
		rootDir: "/tmp/secret-test",
		createdAt: new Date().toISOString(),
		git: {
			remoteUrl: "https://github.com/example/repo.git",
			branch: "main",
			tokenRef: "tok_super_secret_git_token",
			username: "user",
			lastSha: "abc123",
		},
		ssh: {
			target: "user@host:/path",
			host: "host",
			remotePath: "/path",
			authMethod: "password",
			secretRef: "tok_super_secret_ssh_password",
			mountpoint: "/tmp/mount",
		},
	};

	const safe = sanitizeWorkspace(ws);

	assert.equal(safe.git?.tokenRef, undefined, "git tokenRef removed");
	assert.equal(safe.ssh?.secretRef, undefined, "ssh secretRef removed");
	assert.equal(safe.git?.remoteUrl, "https://github.com/example/repo.git", "other git fields kept");
	assert.equal(safe.ssh?.host, "host", "other ssh fields kept");

	const json = JSON.stringify(safe);
	assert.ok(!json.includes("tok_super_secret"), "serialized response must not contain secret tokens");
	assert.ok(!json.includes("tokenRef"), "serialized response must not contain tokenRef key");
	assert.ok(!json.includes("secretRef"), "serialized response must not contain secretRef key");
});

test("sanitizeWorkspace is a no-op for non-secret workspaces", () => {
	const ws: Workspace = {
		id: "ws_plain001",
		name: "Plain",
		rootDir: "/tmp/plain",
		createdAt: new Date().toISOString(),
	};
	const safe = sanitizeWorkspace(ws);
	assert.deepEqual(safe, ws);
});
