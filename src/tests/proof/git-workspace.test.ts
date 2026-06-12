/**
 * Lifecycle tests for git-backed workspaces (src/lib/workspaces.ts).
 * Uses a local git fixture as the clone source via allowLocalPath:true.
 * Skipped if the git binary is not available.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertGitAvailable } from "../../lib/git.js";
import {
	createGitWorkspace,
	refreshGitWorkspace,
	removeWorkspace,
	getWorkspace,
} from "../../lib/workspaces.js";
import { getToken } from "../../lib/git-secrets.js";
import { reposDir } from "../../lib/config.js";

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let gitOk = false;
let tempRoot: string;
let sourceRepo: string;

before(async () => {
	try {
		await assertGitAvailable();
		gitOk = true;
	} catch {
		gitOk = false;
		return;
	}

	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-gitws-"));
	sourceRepo = path.join(tempRoot, "source");
	await mkdir(sourceRepo, { recursive: true });
	execFileSync("git", ["init"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRepo, env: gitEnv });
	await writeFile(path.join(sourceRepo, "README.md"), "# Docs repo\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: sourceRepo, env: gitEnv });
});

after(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("createGitWorkspace registers a read-only workspace and clones files", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		name: "docs",
		allowLocalPath: true,
	});

	assert.equal(ws.readOnly, true, "git workspace must be read-only");
	assert.ok(ws.git, "git metadata present");
	assert.match(ws.git!.lastSha ?? "", /^[0-9a-f]{40}$/, "lastSha recorded");
	assert.ok(
		ws.rootDir.startsWith(reposDir() + path.sep),
		`clone dir under managed repos dir, got ${ws.rootDir}`,
	);
	assert.ok(existsSync(path.join(ws.rootDir, "README.md")), "cloned file exists");

	// Cleanup
	await removeWorkspace(ws.id);
});

test("refreshGitWorkspace fast-forwards lastSha after a new upstream commit", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		name: "docs2",
		allowLocalPath: true,
	});
	const sha0 = ws.git!.lastSha;

	// New commit upstream.
	await writeFile(path.join(sourceRepo, "second.md"), "second\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Second"], { cwd: sourceRepo, env: gitEnv });

	const res = await refreshGitWorkspace(ws.id);
	assert.notEqual(res.lastSha, sha0, "lastSha advances after pull");

	const reloaded = await getWorkspace(ws.id);
	assert.equal(reloaded?.git?.lastSha, res.lastSha, "persisted lastSha matches");
	assert.equal(reloaded?.git?.lastError, undefined, "no error after good pull");

	await removeWorkspace(ws.id);
});

test("removeWorkspace deletes the clone dir and the stored token", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		name: "docs3",
		token: "secret-pat-value",
		allowLocalPath: true,
	});
	const tokenRef = ws.git!.tokenRef;
	assert.ok(tokenRef, "token stored, ref present");
	assert.equal(await getToken(tokenRef!), "secret-pat-value", "token retrievable before remove");
	const cloneDir = ws.rootDir;
	assert.ok(existsSync(cloneDir), "clone dir exists before remove");

	await removeWorkspace(ws.id);

	assert.equal(await getWorkspace(ws.id), null, "workspace unregistered");
	assert.equal(existsSync(cloneDir), false, "clone dir removed");
	assert.equal(await getToken(tokenRef!), null, "token deleted");
});

test("createGitWorkspace rejects a non-https URL when not allowLocalPath", async () => {
	if (!gitOk) return;
	await assert.rejects(
		() => createGitWorkspace({ remoteUrl: "file:///etc/passwd" }),
		/file|scheme|allowed/i,
	);
});
