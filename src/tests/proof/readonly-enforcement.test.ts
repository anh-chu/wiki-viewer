/**
 * Read-only enforcement: a git-backed (readOnly) workspace must reject write
 * intent at the resolver layer, while reads still pass. Covers both the
 * session resolver (resolveWorkspaceForUser) and the agent resolver
 * (resolveWorkspaceForAgent). Runs in --no-auth mode so no session is needed.
 * Skipped if the git binary is not available.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertGitAvailable } from "../../lib/git.js";
import {
	createGitWorkspace,
	createWorkspace,
	removeWorkspace,
	sanitizeWorkspace,
} from "../../lib/workspaces.js";
import {
	resolveWorkspaceForUser,
	resolveWorkspaceForAgent,
} from "../../lib/workspace-context.js";

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
let prevNoAuth: string | undefined;

let roId: string; // read-only git workspace id
let rwRoot: string; // plain workspace root
let rwId: string; // plain (writable) workspace id

function reqFor(wsId: string): Request {
	return new Request(`http://localhost/api/x?ws=${wsId}`);
}

before(async () => {
	try {
		await assertGitAvailable();
		gitOk = true;
	} catch {
		gitOk = false;
		return;
	}

	prevNoAuth = process.env.WIKI_NO_AUTH;
	process.env.WIKI_NO_AUTH = "1";

	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-ro-"));
	sourceRepo = path.join(tempRoot, "source");
	await mkdir(sourceRepo, { recursive: true });
	execFileSync("git", ["init"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRepo, env: gitEnv });
	await writeFile(path.join(sourceRepo, "README.md"), "# Docs\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env: gitEnv });
	execFileSync("git", ["commit", "-m", "init"], { cwd: sourceRepo, env: gitEnv });

	const ro = await createGitWorkspace({ remoteUrl: sourceRepo, name: "ro", allowLocalPath: true });
	roId = ro.id;

	rwRoot = path.join(tempRoot, "writable");
	await mkdir(rwRoot, { recursive: true });
	const rw = await createWorkspace({ rootDir: rwRoot, name: "rw" });
	rwId = rw.id;
});

after(async () => {
	if (gitOk) {
		await removeWorkspace(roId).catch(() => {});
		await removeWorkspace(rwId).catch(() => {});
	}
	if (prevNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = prevNoAuth;
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("resolveWorkspaceForUser: write intent on read-only ws -> 403 WORKSPACE_READ_ONLY", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForUser(reqFor(roId), "write");
	assert.equal(res.ok, false);
	assert.equal(!res.ok && res.status, 403);
	assert.equal(!res.ok && res.code, "WORKSPACE_READ_ONLY");
});

test("resolveWorkspaceForUser: read intent on read-only ws -> ok", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForUser(reqFor(roId), "read");
	assert.equal(res.ok, true);
});

test("resolveWorkspaceForUser: default intent is read (ok on read-only ws)", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForUser(reqFor(roId));
	assert.equal(res.ok, true);
});

test("resolveWorkspaceForUser: write intent on writable ws -> ok", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForUser(reqFor(rwId), "write");
	assert.equal(res.ok, true);
});

test("resolveWorkspaceForAgent: write intent on read-only ws -> 403 WORKSPACE_READ_ONLY", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForAgent(reqFor(roId), "write");
	assert.equal(res.ok, false);
	assert.equal(!res.ok && res.status, 403);
	assert.equal(!res.ok && res.code, "WORKSPACE_READ_ONLY");
});

test("resolveWorkspaceForAgent: read intent on read-only ws -> ok", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForAgent(reqFor(roId), "read");
	assert.equal(res.ok, true);
});

test("resolveWorkspaceForAgent: write intent on writable ws -> ok", async () => {
	if (!gitOk) return;
	const res = await resolveWorkspaceForAgent(reqFor(rwId), "write");
	assert.equal(res.ok, true);
});

test("sanitizeWorkspace strips git.tokenRef but keeps other metadata", () => {
	const ws = {
		id: "ws_test",
		name: "t",
		rootDir: "/tmp/x",
		createdAt: new Date().toISOString(),
		readOnly: true,
		git: {
			remoteUrl: "https://github.com/org/repo.git",
			branch: "main",
			tokenRef: "git_secretref",
			lastSha: "a".repeat(40),
		},
	};
	const safe = sanitizeWorkspace(ws);
	assert.equal(
		(safe.git as Record<string, unknown> | undefined)?.tokenRef,
		undefined,
		"tokenRef must not survive sanitize",
	);
	assert.equal(safe.git?.remoteUrl, "https://github.com/org/repo.git");
	assert.equal(safe.git?.branch, "main");
	assert.equal(safe.git?.lastSha, "a".repeat(40));
	assert.equal(safe.readOnly, true);
	// Original object must not be mutated.
	assert.equal(ws.git.tokenRef, "git_secretref");
});
