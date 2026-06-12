/**
 * Focused tests for gitBranches and gitCheckout lib functions.
 * Skips silently if git binary is not available.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	assertGitAvailable,
	gitBranches,
	gitCheckout,
} from "../../lib/git.js";

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test User",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test User",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let gitOk = false;
let tempRoot: string;
let repoDir: string;
let featureBranch: string;

before(async () => {
	try {
		await assertGitAvailable();
		gitOk = true;
	} catch {
		return;
	}

	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-branches-ck-"));
	repoDir = path.join(tempRoot, "repo");
	await mkdir(repoDir, { recursive: true });

	execFileSync("git", ["init"], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, env: gitEnv });

	await writeFile(path.join(repoDir, "README.md"), "# Hello\n");
	execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir, env: gitEnv });

	// Create a second branch for checkout tests
	featureBranch = "feature-branch-test";
	execFileSync("git", ["checkout", "-b", featureBranch], { cwd: repoDir, env: gitEnv });
	// Switch back to main/master so we can checkout feature-branch-test
	execFileSync("git", ["checkout", "-"], { cwd: repoDir, env: gitEnv });
});

after(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// gitBranches
// ---------------------------------------------------------------------------

describe("gitBranches", () => {
	test("returns array with at least one branch", async () => {
		if (!gitOk) return;
		const branches = await gitBranches(repoDir);
		assert.ok(Array.isArray(branches));
		assert.ok(branches.length >= 1, `expected branches, got ${JSON.stringify(branches)}`);
	});

	test("marks exactly one branch as current", async () => {
		if (!gitOk) return;
		const branches = await gitBranches(repoDir);
		const current = branches.filter((b) => b.current);
		assert.equal(current.length, 1, "exactly one branch should be current");
		assert.ok(current[0].name.length > 0, "current branch has non-empty name");
	});

	test("lists all local branches including feature branch", async () => {
		if (!gitOk) return;
		const branches = await gitBranches(repoDir);
		const names = branches.map((b) => b.name);
		assert.ok(names.includes(featureBranch), `expected ${featureBranch} in ${JSON.stringify(names)}`);
	});
});

// ---------------------------------------------------------------------------
// gitCheckout
// ---------------------------------------------------------------------------

describe("gitCheckout", () => {
	test("throws with invalidBranch=true for invalid branch name format", async () => {
		if (!gitOk) return;
		const err = await gitCheckout(repoDir, "../../evil").catch((e) => e);
		assert.ok(err instanceof Error, "should throw Error");
		assert.equal((err as Error & { invalidBranch?: boolean }).invalidBranch, true);
	});

	test("throws with invalidBranch=true for branch name with semicolon", async () => {
		if (!gitOk) return;
		const err = await gitCheckout(repoDir, "main;evil").catch((e) => e);
		assert.ok(err instanceof Error, "should throw Error");
		assert.equal((err as Error & { invalidBranch?: boolean }).invalidBranch, true);
	});

	test("succeeds on clean repo when checking out existing branch", async () => {
		if (!gitOk) return;
		const result = await gitCheckout(repoDir, featureBranch);
		assert.equal(result.branch, featureBranch);
		assert.match(result.sha, /^[0-9a-f]{40}$/);
		// Switch back
		execFileSync("git", ["checkout", "-"], { cwd: repoDir, env: gitEnv });
	});

	test("throws with dirty=true when working tree has uncommitted changes", async () => {
		if (!gitOk) return;
		// Create an untracked file to make repo dirty
		await writeFile(path.join(repoDir, "untracked.txt"), "dirty\n");
		// Stage it to make it appear in porcelain status
		execFileSync("git", ["add", "untracked.txt"], { cwd: repoDir, env: gitEnv });

		try {
			const err = await gitCheckout(repoDir, featureBranch).catch((e) => e);
			assert.ok(err instanceof Error, "should throw Error");
			assert.equal((err as Error & { dirty?: boolean }).dirty, true);
		} finally {
			// Clean up the staged file
			execFileSync("git", ["restore", "--staged", "untracked.txt"], { cwd: repoDir, env: gitEnv });
			const { rm: rmFile } = await import("node:fs/promises");
			await rmFile(path.join(repoDir, "untracked.txt"));
		}
	});
});
