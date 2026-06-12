/**
 * Tests for git read features: history, diff, file-info, branches, checkout.
 * Covers lib functions and API route handlers.
 * Skipped inline (early return) if the git binary is not available.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	assertGitAvailable,
	gitFileHistory,
	gitFileDiff,
	gitFileInfo,
	gitBranches,
	gitCheckout,
	findEnclosingGitRepo,
} from "../../lib/git.js";

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Test User",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "Test User",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

let gitOk = false;
// Lib test fixture
let tempRoot: string;
let repoDir: string;
let firstSha: string;
let secondSha: string;
// Route test fixture
let tmpHome: string;
let tmpRootDir: string;
let subrepoDir: string;
let routeSha: string;

before(async () => {
	try {
		await assertGitAvailable();
		gitOk = true;
	} catch {
		return;
	}

	// ── Lib test repo ─────────────────────────────────────────────────────────
	tempRoot = await mkdtemp(path.join(tmpdir(), "wiki-git-features-"));
	repoDir = path.join(tempRoot, "testrepo");
	await mkdir(repoDir, { recursive: true });

	execFileSync("git", ["init"], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, env: gitEnv });

	await writeFile(path.join(repoDir, "README.md"), "# First\n");
	execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: repoDir, env: gitEnv });
	firstSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env: gitEnv })
		.toString().trim();

	await writeFile(path.join(repoDir, "README.md"), "# First\n\nAdded line.\n");
	execFileSync("git", ["add", "."], { cwd: repoDir, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Second commit"], { cwd: repoDir, env: gitEnv });
	secondSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, env: gitEnv })
		.toString().trim();

	// ── Route test fixture ─────────────────────────────────────────────────────
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-git-rt-home-"));
	process.env.HOME = tmpHome;
	process.env.AUTH_ALLOWED_DOMAIN = "test.local";

	tmpRootDir = await mkdtemp(path.join(tmpdir(), "wiki-git-rt-root-"));
	process.env.ROOT_DIR = tmpRootDir;

	const { setRootDir } = await import("../../lib/root-dir.js");
	setRootDir(tmpRootDir);

	subrepoDir = path.join(tmpRootDir, "myrepo");
	await mkdir(subrepoDir, { recursive: true });
	execFileSync("git", ["init"], { cwd: subrepoDir, env: gitEnv });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: subrepoDir, env: gitEnv });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: subrepoDir, env: gitEnv });
	await writeFile(path.join(subrepoDir, "page.md"), "# Page\n");
	execFileSync("git", ["add", "."], { cwd: subrepoDir, env: gitEnv });
	execFileSync("git", ["commit", "-m", "Init"], { cwd: subrepoDir, env: gitEnv });
	routeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: subrepoDir, env: gitEnv })
		.toString().trim();

	// Outside file for non-git tests
	await writeFile(path.join(tmpRootDir, "outside.md"), "# Outside\n");
	// Non-git directory for branches 400 test
	await mkdir(path.join(tmpRootDir, "notgit"), { recursive: true });
});

after(async () => {
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
	if (tmpRootDir) await rm(tmpRootDir, { recursive: true, force: true });
	if (tmpHome) {
		await rm(tmpHome, { recursive: true, force: true });
		delete process.env.AUTH_ALLOWED_DOMAIN;
	}
});

// Helper: import makeUserSession lazily so HOME is already set
async function session(): Promise<string> {
	const { makeUserSession } = await import("./helpers/auth-session.js");
	return makeUserSession();
}

// ---------------------------------------------------------------------------
// gitFileHistory
// ---------------------------------------------------------------------------

describe("gitFileHistory", () => {
	test("returns commits affecting a file", async () => {
		if (!gitOk) return;
		const commits = await gitFileHistory(repoDir, "README.md");
		assert.equal(commits.length, 2, "two commits for README.md");
		assert.equal(commits[0].sha, secondSha);
		assert.equal(commits[1].sha, firstSha);
		assert.ok(commits[0].shortSha.length === 7);
		assert.ok(commits[0].message.length > 0);
		assert.ok(commits[0].author.length > 0);
		assert.ok(commits[0].date.includes("T"), "date is ISO 8601");
	});

	test("returns empty array for unknown file", async () => {
		if (!gitOk) return;
		const commits = await gitFileHistory(repoDir, "nonexistent.md");
		assert.deepEqual(commits, []);
	});
});

// ---------------------------------------------------------------------------
// gitFileDiff
// ---------------------------------------------------------------------------

describe("gitFileDiff", () => {
	test("returns diff for second commit", async () => {
		if (!gitOk) return;
		const diff = await gitFileDiff(repoDir, "README.md", secondSha);
		assert.ok(diff.includes("Added line."), "diff includes added content");
		assert.ok(diff.includes("@@"), "diff contains hunk header");
	});

	test("returns output for initial commit (no parent)", async () => {
		if (!gitOk) return;
		const diff = await gitFileDiff(repoDir, "README.md", firstSha);
		assert.ok(diff.length > 0, "initial commit produces output");
	});
});

// ---------------------------------------------------------------------------
// gitFileInfo
// ---------------------------------------------------------------------------

describe("gitFileInfo", () => {
	test("returns author and date for latest commit on file", async () => {
		if (!gitOk) return;
		const info = await gitFileInfo(repoDir, "README.md");
		assert.ok(info !== null);
		assert.equal(info!.sha, secondSha);
		assert.equal(info!.author, "Test User");
		assert.ok(info!.date.includes("T"));
	});

	test("returns null for file with no git history", async () => {
		if (!gitOk) return;
		const info = await gitFileInfo(repoDir, "nowhere.md");
		assert.equal(info, null);
	});
});

// ---------------------------------------------------------------------------
// gitBranches
// ---------------------------------------------------------------------------

describe("gitBranches", () => {
	test("returns branch list with current marked", async () => {
		if (!gitOk) return;
		const branches = await gitBranches(repoDir);
		assert.ok(branches.length >= 1);
		const current = branches.find((b) => b.current);
		assert.ok(current, "at least one branch is current");
		assert.ok(current!.name.length > 0);
	});
});

// ---------------------------------------------------------------------------
// gitCheckout
// ---------------------------------------------------------------------------

describe("gitCheckout", () => {
	test("rejects invalid branch name", async () => {
		if (!gitOk) return;
		await assert.rejects(
			() => gitCheckout(repoDir, "../../evil"),
			/invalid branch/i,
		);
	});

	test("rejects branch name with semicolon", async () => {
		if (!gitOk) return;
		await assert.rejects(
			() => gitCheckout(repoDir, "main;rm -rf /"),
			/invalid branch/i,
		);
	});

	test("creates and checks out a new branch via git CLI, then switches back", async () => {
		if (!gitOk) return;
		execFileSync("git", ["checkout", "-b", "feature-test"], { cwd: repoDir, env: gitEnv });
		const result = await gitCheckout(repoDir, "feature-test");
		assert.equal(result.branch, "feature-test");
		assert.match(result.sha, /^[0-9a-f]{40}$/);
		// Switch back using git directly to leave repo in clean state
		execFileSync("git", ["checkout", "-"], { cwd: repoDir, env: gitEnv });
	});
});

// ---------------------------------------------------------------------------
// findEnclosingGitRepo
// ---------------------------------------------------------------------------

describe("findEnclosingGitRepo", () => {
	test("finds repo for file inside a sub-repo", async () => {
		if (!gitOk) return;
		const result = await findEnclosingGitRepo(tempRoot, "testrepo/README.md");
		assert.ok(result !== null);
		assert.equal(result!.repoDir, repoDir);
		assert.equal(result!.relFromRepo, "README.md");
	});

	test("returns null for file not inside any git repo", async () => {
		if (!gitOk) return;
		const outsideDir = await mkdtemp(path.join(tmpdir(), "no-git-"));
		try {
			const result = await findEnclosingGitRepo(outsideDir, "some/file.md");
			assert.equal(result, null);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	test("handles nested path correctly", async () => {
		if (!gitOk) return;
		await mkdir(path.join(repoDir, "docs"), { recursive: true });
		await writeFile(path.join(repoDir, "docs", "note.md"), "note\n");
		const result = await findEnclosingGitRepo(tempRoot, "testrepo/docs/note.md");
		assert.ok(result !== null);
		assert.equal(result!.repoDir, repoDir);
		assert.equal(result!.relFromRepo, "docs/note.md");
	});
});

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

test("GET /api/wiki/git-history without auth returns 401", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-history/route.js");
	const req = new Request("http://localhost:3000/api/wiki/git-history?path=myrepo/page.md");
	const res = await GET(req);
	assert.equal(res.status, 401);
});

test("GET /api/wiki/git-history with auth returns commits array", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-history/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-history?path=myrepo/page.md", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { commits: Array<{ sha: string; message: string; author: string; date: string }> };
	assert.ok(Array.isArray(body.commits));
	assert.ok(body.commits.length >= 1, `expected commits, got ${JSON.stringify(body)}`);
	assert.ok(typeof body.commits[0].sha === "string");
	assert.ok(typeof body.commits[0].author === "string");
});

test("GET /api/wiki/git-history with missing path returns 400", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-history/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-history", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 400);
});

test("GET /api/wiki/git-history for file not in git repo returns empty commits", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-history/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-history?path=outside.md", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { commits: unknown[] };
	assert.deepEqual(body.commits, []);
});

test("GET /api/wiki/git-diff without auth returns 401", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-diff/route.js");
	const req = new Request(`http://localhost:3000/api/wiki/git-diff?path=myrepo/page.md&sha=${routeSha}`);
	const res = await GET(req);
	assert.equal(res.status, 401);
});

test("GET /api/wiki/git-diff with invalid sha returns 400", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-diff/route.js");
	const cookie = await session();
	const req = new Request(
		"http://localhost:3000/api/wiki/git-diff?path=myrepo/page.md&sha=not-a-sha!!",
		{ headers: { Cookie: cookie } },
	);
	const res = await GET(req);
	assert.equal(res.status, 400);
});

test("GET /api/wiki/git-diff returns diff text", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-diff/route.js");
	const cookie = await session();
	const req = new Request(
		`http://localhost:3000/api/wiki/git-diff?path=myrepo/page.md&sha=${routeSha}`,
		{ headers: { Cookie: cookie } },
	);
	const res = await GET(req);
	assert.equal(res.status, 200, `expected 200, got ${res.status}`);
	const body = (await res.json()) as { diff: string };
	assert.ok(typeof body.diff === "string");
	assert.ok(body.diff.length > 0, "diff should not be empty");
});

test("GET /api/wiki/git-file-info without auth returns 401", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-file-info/route.js");
	const req = new Request("http://localhost:3000/api/wiki/git-file-info?path=myrepo/page.md");
	const res = await GET(req);
	assert.equal(res.status, 401);
});

test("GET /api/wiki/git-file-info returns author and date", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-file-info/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-file-info?path=myrepo/page.md", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 200, `expected 200, got ${res.status}`);
	const body = (await res.json()) as { info: { sha: string; author: string; date: string } | null };
	assert.ok(body.info !== null, `expected info, got ${JSON.stringify(body)}`);
	assert.ok(typeof body.info!.sha === "string");
	assert.ok(typeof body.info!.author === "string");
	assert.ok(body.info!.date.includes("T"));
});

test("GET /api/wiki/git-file-info for non-git file returns null info", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-file-info/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-file-info?path=outside.md", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { info: null };
	assert.equal(body.info, null);
});

test("GET /api/wiki/git-branches without auth returns 401", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-branches/route.js");
	const req = new Request("http://localhost:3000/api/wiki/git-branches?path=myrepo");
	const res = await GET(req);
	assert.equal(res.status, 401);
});

test("GET /api/wiki/git-branches returns branch list", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-branches/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-branches?path=myrepo", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 200, `expected 200, got ${res.status}`);
	const body = (await res.json()) as { branches: Array<{ name: string; current: boolean }>; current: string };
	assert.ok(Array.isArray(body.branches));
	assert.ok(body.branches.length >= 1, `expected branches, got ${JSON.stringify(body)}`);
	assert.ok(typeof body.current === "string");
	const cur = body.branches.find((b) => b.current);
	assert.ok(cur, "at least one branch marked as current");
});

test("GET /api/wiki/git-branches for non-repo returns 400", async () => {
	if (!gitOk) return;
	const { GET } = await import("../../app/api/wiki/git-branches/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-branches?path=notgit", {
		headers: { Cookie: cookie },
	});
	const res = await GET(req);
	assert.equal(res.status, 400);
});

test("POST /api/wiki/git-checkout without auth returns 401", async () => {
	if (!gitOk) return;
	const { POST } = await import("../../app/api/wiki/git-checkout/route.js");
	const req = new Request("http://localhost:3000/api/wiki/git-checkout", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: "myrepo", branch: "main" }),
	});
	const res = await POST(req);
	assert.equal(res.status, 401);
});

test("POST /api/wiki/git-checkout with invalid branch name returns 400", async () => {
	if (!gitOk) return;
	const { POST } = await import("../../app/api/wiki/git-checkout/route.js");
	const cookie = await session();
	const req = new Request("http://localhost:3000/api/wiki/git-checkout", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: "http://localhost:3000",
		},
		body: JSON.stringify({ path: "myrepo", branch: "../evil" }),
	});
	const res = await POST(req);
	assert.equal(res.status, 400);
});

test("POST /api/wiki/git-checkout on current branch succeeds", async () => {
	if (!gitOk) return;
	const { POST } = await import("../../app/api/wiki/git-checkout/route.js");
	const cookie = await session();
	const currentBranchName = execFileSync(
		"git", ["rev-parse", "--abbrev-ref", "HEAD"],
		{ cwd: subrepoDir, env: gitEnv },
	).toString().trim();
	const req = new Request("http://localhost:3000/api/wiki/git-checkout", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: cookie,
			Origin: "http://localhost:3000",
		},
		body: JSON.stringify({ path: "myrepo", branch: currentBranchName }),
	});
	const res = await POST(req);
	assert.equal(res.status, 200, `expected 200, got ${res.status}`);
	const body = (await res.json()) as { ok: boolean; branch: string; sha: string };
	assert.equal(body.ok, true);
	assert.equal(body.branch, currentBranchName);
	assert.match(body.sha, /^[0-9a-f]{40}$/);
});
