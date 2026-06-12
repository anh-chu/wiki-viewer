/**
 * Tests for git sparse-checkout (subpath) support in git-backed workspaces.
 * Uses a local git fixture; skipped if git binary not available.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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

	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-sparse-"));
	sourceRepo = path.join(tempRoot, "source");
	await mkdir(path.join(sourceRepo, "docs"), { recursive: true });
	await mkdir(path.join(sourceRepo, "app"), { recursive: true });

	execFileSync("git", ["init"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRepo, env: gitEnv });

	await writeFile(path.join(sourceRepo, "README.md"), "# Root readme\n");
	await writeFile(path.join(sourceRepo, "docs", "guide.md"), "# Guide\n");
	await writeFile(path.join(sourceRepo, "docs", "api.md"), "# API\n");
	await writeFile(path.join(sourceRepo, "app", "main.ts"), "// app code\n");

	execFileSync("git", ["add", "."], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: sourceRepo, env: gitEnv });
});

after(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("createGitWorkspace with subpath: rootDir points at subdir, app/ not visible", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		subpath: "docs",
		name: "sparse-docs",
		allowLocalPath: true,
	});

	assert.equal(ws.readOnly, true);
	assert.ok(ws.git, "git metadata present");
	assert.equal(ws.git!.subpath, "docs", "subpath recorded");
	assert.ok(ws.git!.cloneRoot, "cloneRoot recorded");
	assert.ok(
		ws.git!.cloneRoot!.startsWith(reposDir() + path.sep),
		"cloneRoot under managed repos dir",
	);
	assert.ok(ws.rootDir.endsWith(path.sep + "docs"), `rootDir ends with /docs, got ${ws.rootDir}`);
	assert.ok(
		ws.rootDir.startsWith(ws.git!.cloneRoot!),
		"rootDir is inside cloneRoot",
	);
	assert.match(ws.git!.lastSha ?? "", /^[0-9a-f]{40}$/, "lastSha is a 40-char sha");

	// Docs files visible in rootDir
	assert.ok(existsSync(path.join(ws.rootDir, "guide.md")), "guide.md in rootDir");
	assert.ok(existsSync(path.join(ws.rootDir, "api.md")), "api.md in rootDir");

	// app/ dir NOT visible in rootDir (outside the sparse cone)
	assert.equal(
		existsSync(path.join(ws.rootDir, "..", "app")),
		// app/ sits in cloneRoot, not inside rootDir — assert it is not in rootDir
		false,
		"app/ not inside rootDir",
	);
	// cloneRoot exists; app is absent from the working tree (sparse cone)
	assert.ok(existsSync(ws.git!.cloneRoot!), "cloneRoot dir exists");
	assert.equal(
		existsSync(path.join(ws.git!.cloneRoot!, "app")),
		false,
		"app/ dir absent from sparse working tree",
	);

	await removeWorkspace(ws.id);
});

test("refreshGitWorkspace: new docs commit visible, lastSha advances", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		subpath: "docs",
		name: "sparse-refresh",
		allowLocalPath: true,
	});
	const sha0 = ws.git!.lastSha!;

	// Add new doc upstream
	await writeFile(path.join(sourceRepo, "docs", "new.md"), "# New page\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Add new doc"], { cwd: sourceRepo, env: gitEnv });

	const res = await refreshGitWorkspace(ws.id);
	assert.notEqual(res.lastSha, sha0, "lastSha advances after pull");
	assert.ok(existsSync(path.join(ws.rootDir, "new.md")), "new doc materialized in rootDir");

	const reloaded = await getWorkspace(ws.id);
	assert.equal(reloaded?.git?.lastSha, res.lastSha, "persisted lastSha matches");

	await removeWorkspace(ws.id);
});

test("removeWorkspace: entire cloneRoot deleted, not just subdir", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		subpath: "docs",
		name: "sparse-remove",
		token: "fake-pat-for-test",
		allowLocalPath: true,
	});

	const cloneRoot = ws.git!.cloneRoot!;
	const tokenRef = ws.git!.tokenRef;
	assert.ok(tokenRef, "tokenRef present");
	assert.ok(existsSync(cloneRoot), "cloneRoot exists before remove");

	await removeWorkspace(ws.id);

	assert.equal(await getWorkspace(ws.id), null, "workspace unregistered");
	assert.equal(existsSync(cloneRoot), false, "entire cloneRoot removed");
	assert.equal(await getToken(tokenRef!), null, "token deleted");
});

test("createGitWorkspace: bad subpath rejects with error, no leftover", async () => {
	if (!gitOk) return;

	// Determine how many workspaces exist before
	const { listWorkspaces } = await import("../../lib/workspaces.js");
	const before = (await listWorkspaces()).length;

	await assert.rejects(
		() =>
			createGitWorkspace({
				remoteUrl: sourceRepo,
				subpath: "nonexistent-dir",
				allowLocalPath: true,
			}),
		/nonexistent-dir|not found/i,
	);

	const after = (await listWorkspaces()).length;
	assert.equal(after, before, "no workspace registered on bad subpath");

	// No leftover clone dir for the failed workspace
	const { reposDir: getReposDir } = await import("../../lib/config.js");
	const { readdirSync, existsSync: fsExists } = await import("node:fs");
	const reposBase = getReposDir();
	if (fsExists(reposBase)) {
		// All dirs in repos/ should belong to pre-existing workspaces
		const ids = new Set((await listWorkspaces()).map((w) => w.id));
		const dirs = readdirSync(reposBase);
		for (const d of dirs) {
			assert.ok(ids.has(d), `orphaned clone dir found: ${d}`);
		}
	}
});

test("createGitWorkspace: subpath that is a symlink is rejected (no escape)", async () => {
	if (!gitOk) return;
	if (process.platform === "win32") return; // symlink semantics differ on Windows

	// Build a repo whose committed "link" entry is a symlink to an outside dir.
	const { symlinkSync } = await import("node:fs");
	const linkRepo = path.join(tempRoot, "linkrepo");
	const outside = path.join(tempRoot, "outside-secret");
	await mkdir(outside, { recursive: true });
	await writeFile(path.join(outside, "secret.txt"), "do not serve me\n");
	await mkdir(linkRepo, { recursive: true });
	execFileSync("git", ["init"], { cwd: linkRepo, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: linkRepo, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: linkRepo, env: gitEnv });
	await writeFile(path.join(linkRepo, "README.md"), "# root\n");
	// A symlink named "link" pointing at the outside dir, committed into the repo.
	symlinkSync(outside, path.join(linkRepo, "link"));
	execFileSync("git", ["add", "-A"], { cwd: linkRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "add symlink"], { cwd: linkRepo, env: gitEnv });

	const { listWorkspaces } = await import("../../lib/workspaces.js");
	const before = (await listWorkspaces()).length;

	// Requesting the symlink as subpath must be rejected; we must never register
	// a workspace whose rootDir resolves outside the clone.
	// Rejected at one of two layers: git's cone check refuses a non-directory
	// ("is not a directory"), or our post-clone lstat guard ("not found").
	// Either way the workspace must not register and rootDir must never resolve
	// to the outside symlink target.
	await assert.rejects(
		() =>
			createGitWorkspace({
				remoteUrl: linkRepo,
				subpath: "link",
				allowLocalPath: true,
			}),
		/not a directory|not found/i,
	);
	const after = (await listWorkspaces()).length;
	assert.equal(after, before, "no workspace registered for symlink subpath");
});

test("createGitWorkspace whole-repo (no subpath) regression: rootDir === cloneRoot", async () => {
	if (!gitOk) return;

	const ws = await createGitWorkspace({
		remoteUrl: sourceRepo,
		name: "whole-repo",
		allowLocalPath: true,
	});

	assert.equal(ws.git!.subpath, undefined, "no subpath on whole-repo");
	assert.equal(ws.git!.cloneRoot, undefined, "no cloneRoot stored for whole-repo");
	assert.ok(
		ws.rootDir.startsWith(reposDir() + path.sep),
		"rootDir under managed repos dir",
	);
	assert.ok(existsSync(path.join(ws.rootDir, "README.md")), "README.md cloned");
	assert.ok(existsSync(path.join(ws.rootDir, "docs", "guide.md")), "docs/guide.md cloned");

	await removeWorkspace(ws.id);
});
