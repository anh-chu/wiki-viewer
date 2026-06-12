/**
 * Tests for src/lib/git.ts
 * - validateRemoteUrl: pure unit tests, no network, no git binary needed.
 * - clone/pull/headSha/currentBranch: use a local git fixture. Skipped if git not available.
 */
import { test, before, after, describe, skip } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	validateRemoteUrl,
	assertGitAvailable,
	cloneRepo,
	pullRepo,
	headSha,
	currentBranch,
} from "../../lib/git.js";

// ----------------------------
// validateRemoteUrl: pure unit tests
// ----------------------------

describe("validateRemoteUrl", () => {
	test("accepts https URL", () => {
		const result = validateRemoteUrl("https://github.com/org/repo.git");
		assert.ok(result.ok, `Expected ok, got: ${!result.ok && result.reason}`);
		assert.equal(result.ok && result.url.hostname, "github.com");
	});

	test("accepts https URL for GitLab", () => {
		const result = validateRemoteUrl("https://gitlab.com/org/repo.git");
		assert.ok(result.ok);
	});

	test("accepts https URL with port", () => {
		const result = validateRemoteUrl("https://ghe.corp.example.com:8443/org/repo.git");
		assert.ok(result.ok);
	});

	test("rejects http by default", () => {
		const result = validateRemoteUrl("http://github.com/org/repo.git");
		assert.ok(!result.ok);
		assert.match(result.ok ? "" : result.reason, /http/);
	});

	test("accepts http when allowInsecureHttp is true", () => {
		const result = validateRemoteUrl("http://gitea.internal/org/repo.git", {
			allowInsecureHttp: true,
		});
		assert.ok(result.ok);
	});

	test("rejects file: scheme", () => {
		const result = validateRemoteUrl("file:///etc/passwd");
		assert.ok(!result.ok);
		assert.match(result.ok ? "" : result.reason, /file/i);
	});

	test("rejects ext: scheme", () => {
		const result = validateRemoteUrl("ext::evil-command");
		// This may fail URL parsing or scheme check - either is fine.
		assert.ok(!result.ok);
	});

	test("rejects git: scheme", () => {
		const result = validateRemoteUrl("git://github.com/org/repo.git");
		assert.ok(!result.ok);
	});

	test("rejects ssh: scheme", () => {
		const result = validateRemoteUrl("ssh://git@github.com/org/repo.git");
		assert.ok(!result.ok);
	});

	test("rejects URL with semicolon", () => {
		const result = validateRemoteUrl("https://github.com/org/repo;rm -rf /");
		assert.ok(!result.ok);
		assert.match(result.ok ? "" : result.reason, /forbidden/i);
	});

	test("rejects URL with pipe", () => {
		const result = validateRemoteUrl("https://github.com/org/repo|evil");
		assert.ok(!result.ok);
	});

	test("rejects URL with newline", () => {
		const result = validateRemoteUrl("https://github.com/org/repo\nevil");
		assert.ok(!result.ok);
	});

	test("rejects URL with null byte", () => {
		const result = validateRemoteUrl("https://github.com/org/repo\0evil");
		assert.ok(!result.ok);
	});

	test("rejects URL with backtick", () => {
		const result = validateRemoteUrl("https://github.com/org/repo`echo hi`");
		assert.ok(!result.ok);
	});

	test("rejects unparseable URL", () => {
		const result = validateRemoteUrl("not a url at all !!!");
		assert.ok(!result.ok);
	});

	test("allowedHosts: accepts matching host", () => {
		const result = validateRemoteUrl("https://github.com/org/repo.git", {
			allowedHosts: ["github.com"],
		});
		assert.ok(result.ok);
	});

	test("allowedHosts: rejects non-matching host", () => {
		const result = validateRemoteUrl("https://evil.example.com/org/repo.git", {
			allowedHosts: ["github.com", "gitlab.com"],
		});
		assert.ok(!result.ok);
		assert.match(result.ok ? "" : result.reason, /allowed hosts/i);
	});

	test("allowedHosts: case-insensitive match", () => {
		const result = validateRemoteUrl("https://GitHub.COM/org/repo.git", {
			allowedHosts: ["github.com"],
		});
		assert.ok(result.ok);
	});

	test("empty allowedHosts array allows any host", () => {
		const result = validateRemoteUrl("https://any-host.example.com/repo.git", {
			allowedHosts: [],
		});
		assert.ok(result.ok);
	});
});

// ----------------------------
// Git fixture tests (skipped if git not available)
// ----------------------------

let gitOk = false;
let sourceRepo: string;
let cloneDir: string;
let tempRoot: string;

before(async () => {
	try {
		await assertGitAvailable();
		gitOk = true;
	} catch {
		gitOk = false;
		return;
	}

	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-git-test-"));
	sourceRepo = path.join(tempRoot, "source");
	cloneDir = path.join(tempRoot, "clone");

	// Initialize a bare-ish source repo with one commit.
	await mkdir(sourceRepo, { recursive: true });

	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};

	execFileSync("git", ["init"], { cwd: sourceRepo, env });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRepo, env });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: sourceRepo, env });

	await writeFile(path.join(sourceRepo, "README.md"), "# Test repo\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: sourceRepo, env });
});

after(async () => {
	if (tempRoot) {
		await rm(tempRoot, { recursive: true, force: true });
	}
});

test("cloneRepo clones a local repo by filesystem path", async () => {
	if (!gitOk) {
		// Skip inline: just return without asserting
		return;
	}
	// Use local filesystem path directly (not file:// URL, which validateRemoteUrl would reject)
	// cloneRepo itself accepts any path; URL validation is the caller's (route layer) responsibility.
	await cloneRepo({ remoteUrl: sourceRepo, destDir: cloneDir });
	const sha = await headSha(cloneDir);
	assert.ok(sha.length === 40, `Expected 40-char SHA, got: ${sha}`);
});

test("currentBranch returns a branch name after clone", async () => {
	if (!gitOk) return;
	const branch = await currentBranch(cloneDir);
	// Could be 'main' or 'master' depending on git version/config
	assert.ok(branch.length > 0, `Expected non-empty branch name, got: '${branch}'`);
	assert.notEqual(branch, "HEAD", "Should be on a branch, not detached HEAD");
});

test("headSha returns consistent SHA", async () => {
	if (!gitOk) return;
	const sha1 = await headSha(cloneDir);
	const sha2 = await headSha(cloneDir);
	assert.equal(sha1, sha2);
	assert.match(sha1, /^[0-9a-f]{40}$/);
});

test("pullRepo fast-forwards to a new commit", async () => {
	if (!gitOk) return;

	const sha0 = await headSha(cloneDir);

	// Add a second commit to the source repo.
	const env = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
	};
	await writeFile(path.join(sourceRepo, "second.md"), "second file\n");
	execFileSync("git", ["add", "."], { cwd: sourceRepo, env });
	execFileSync("git", ["commit", "-m", "Second commit"], { cwd: sourceRepo, env });

	await pullRepo({ rootDir: cloneDir });

	const sha1 = await headSha(cloneDir);
	assert.notEqual(sha0, sha1, "SHA should change after pull");
	assert.match(sha1, /^[0-9a-f]{40}$/);
});

test("assertGitAvailable does not throw when git is present", async () => {
	if (!gitOk) return;
	// Should not throw (and be cached from before() call)
	await assert.doesNotReject(() => assertGitAvailable());
});
