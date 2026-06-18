/**
 * Thin wrapper around the system git binary.
 * Provider-agnostic: works with GitHub, GitLab, Bitbucket, Gitea, GHE, etc.
 * Tokens are injected via GIT_ASKPASS so they never appear in process args,
 * .git/config, or ps output.
 */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, rmSync, chmodSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFile = promisify(_execFile);

// Cached availability check result
let gitAvailable: boolean | undefined;

/** Verify the system git binary exists. Throws if not found. Cached after first call. */
export async function assertGitAvailable(): Promise<void> {
	if (gitAvailable === true) return;
	try {
		await execFile("git", ["--version"]);
		gitAvailable = true;
	} catch {
		throw new Error(
			"git binary not found. Install git and ensure it is on PATH.",
		);
	}
}

// Characters that must not appear in a remote URL even when passed to execFile,
// as defense-in-depth against malformed input reaching git config or log output.
const FORBIDDEN_CHARS = /[;\|&$`<>(){}\n\0]/;

export interface ValidateRemoteUrlOpts {
	allowedHosts?: string[];
	allowInsecureHttp?: boolean;
}

export type ValidateRemoteUrlResult =
	| { ok: true; url: URL }
	| { ok: false; reason: string };

/**
 * Validate a remote URL before passing it to git.
 * Security contract:
 *   - Only https: allowed by default (opt-in http: via allowInsecureHttp).
 *   - file:, ext:, git:, ssh:, and all other schemes are rejected.
 *   - Shell metacharacters and control chars are rejected (defense-in-depth).
 *   - If allowedHosts is non-empty, the hostname must be in the list.
 */
export function validateRemoteUrl(
	remoteUrl: string,
	opts: ValidateRemoteUrlOpts = {},
): ValidateRemoteUrlResult {
	if (FORBIDDEN_CHARS.test(remoteUrl)) {
		return { ok: false, reason: "URL contains forbidden characters" };
	}

	let url: URL;
	try {
		url = new URL(remoteUrl);
	} catch {
		return { ok: false, reason: "URL could not be parsed" };
	}

	const scheme = url.protocol; // includes trailing colon, e.g. "https:"
	if (scheme === "https:") {
		// ok
	} else if (scheme === "http:" && opts.allowInsecureHttp) {
		// ok only when explicitly permitted
	} else if (scheme === "http:") {
		return { ok: false, reason: "http: is not allowed (set allowInsecureHttp to permit)" };
	} else {
		return {
			ok: false,
			reason: `Scheme '${scheme.replace(":", "")}' is not allowed. Use https.`,
		};
	}

	const { allowedHosts } = opts;
	if (allowedHosts && allowedHosts.length > 0) {
		const hostname = url.hostname.toLowerCase();
		const allowed = allowedHosts.map((h) => h.toLowerCase());
		if (!allowed.includes(hostname)) {
			return {
				ok: false,
				reason: `Host '${url.hostname}' is not in the allowed hosts list`,
			};
		}
	}

	return { ok: true, url };
}

/**
 * Write a temporary askpass helper script that prints `token` to stdout.
 * Returns the path. Caller MUST delete it in a finally block.
 * The script is mode 0700 (exec + owner-only).
 */
async function writeAskpassScript(token: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "wiki-git-"));
	const scriptPath = path.join(dir, "askpass.sh");
	// The GIT_ASKPASS contract: git invokes the script with the prompt string
	// as $1. The script prints the credential to stdout. We always print the
	// token regardless of prompt, which covers the password prompt. The username
	// is embedded in the URL userinfo so git skips the username prompt.
	const body = `#!/bin/sh\nprintf '%s' '${token.replace(/'/g, "'\\''")}'`;
	writeFileSync(scriptPath, body, { mode: 0o700 });
	try {
		chmodSync(scriptPath, 0o700);
	} catch {
		// best-effort
	}
	return scriptPath;
}

function removeAskpassScript(scriptPath: string): void {
	try {
		unlinkSync(scriptPath);
	} catch {
		// best-effort cleanup
	}
	// Remove the parent temp dir created by mkdtemp.
	const dir = path.dirname(scriptPath);
	if (dir !== tmpdir()) {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
	}
}

/**
 * Build env vars for git commands that need token auth.
 * Caller is responsible for cleaning up the temp askpass script.
 */
async function buildAuthEnv(token: string): Promise<{ env: NodeJS.ProcessEnv; askpassPath: string }> {
	const askpassPath = await writeAskpassScript(token);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_ASKPASS: askpassPath,
		GIT_TERMINAL_PROMPT: "0",
	};
	return { env, askpassPath };
}

/**
 * Build a clone URL with username embedded in userinfo (in-memory only).
 * Token is NOT in the URL - it comes from the askpass script.
 */
function buildAuthUrl(remoteUrl: string, username: string): string {
	try {
		const u = new URL(remoteUrl);
		u.username = username;
		u.password = ""; // token comes from askpass, not URL
		return u.toString();
	} catch {
		// not a parseable URL (e.g. local path) - return as-is
		return remoteUrl;
	}
}

export interface CloneArgs {
	remoteUrl: string;
	branch?: string;
	token?: string;
	username?: string;
	destDir: string;
	depth?: number;
	/** Sparse cone path (e.g. "docs"). When set, uses --filter=blob:none + sparse-checkout. */
	subpath?: string;
}

/** Validate a subpath for sparse checkout. Throws on invalid input. Returns normalized subpath. */
function validateSubpath(subpath: string): string {
	if (path.isAbsolute(subpath)) throw new Error("subpath must be relative");
	if (subpath.includes("..")) throw new Error("subpath must not contain '..'");
	if (/[\0\n]/.test(subpath)) throw new Error("subpath contains forbidden characters");
	if (FORBIDDEN_CHARS.test(subpath)) throw new Error("subpath contains forbidden characters");
	const normalized = subpath.split(path.sep).join("/").replace(/\/+$/, "");
	if (normalized === ".git" || normalized.startsWith(".git/"))
		throw new Error("subpath must not point at .git");
	return normalized;
}

/** Clone a remote repository. Shallow (depth=1) by default. */
export async function cloneRepo(args: CloneArgs): Promise<void> {
	const { branch, token, destDir, subpath } = args;
	const depth = args.depth ?? 1;
	const username = args.username ?? "x-access-token";

	let normalizedSubpath: string | undefined;
	if (subpath) {
		normalizedSubpath = validateSubpath(subpath);
	}

	const cloneArgs: string[] = ["clone", "--depth", String(depth), "--single-branch", "--no-tags"];
	if (branch) {
		cloneArgs.push("--branch", branch);
	}
	if (normalizedSubpath) {
		cloneArgs.push("--filter=blob:none", "--sparse");
	}

	// For auth: embed username in URL userinfo; token comes from askpass env.
	const remoteUrlForGit = token
		? buildAuthUrl(args.remoteUrl, username)
		: args.remoteUrl;

	cloneArgs.push(remoteUrlForGit, destDir);

	let askpassPath: string | undefined;
	try {
		if (token) {
			const auth = await buildAuthEnv(token);
			askpassPath = auth.askpassPath;
			await execFile("git", cloneArgs, { env: auth.env });
		} else {
			await execFile("git", cloneArgs, {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
		}
		// Apply sparse cone after clone if subpath specified.
		if (normalizedSubpath) {
			await execFile(
				"git",
				["-C", destDir, "sparse-checkout", "set", "--cone", normalizedSubpath],
				{ env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			);
		}
	} finally {
		if (askpassPath) removeAskpassScript(askpassPath);
	}
}

export interface PullArgs {
	rootDir: string;
	token?: string;
	username?: string;
}

/** Pull latest changes in a cloned repo using --ff-only. */
export async function pullRepo(args: PullArgs): Promise<void> {
	const { rootDir, token } = args;
	const pullArgs = ["-C", rootDir, "pull", "--ff-only"];

	let askpassPath: string | undefined;
	try {
		if (token) {
			const auth = await buildAuthEnv(token);
			askpassPath = auth.askpassPath;
			await execFile("git", pullArgs, { env: auth.env });
		} else {
			await execFile("git", pullArgs, {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
		}
	} finally {
		if (askpassPath) removeAskpassScript(askpassPath);
	}
}

/** Return the full SHA of HEAD in the given repo. */
export async function headSha(rootDir: string): Promise<string> {
	const { stdout } = await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"]);
	return stdout.trim();
}

/** Return the current branch name (or "HEAD" if detached). */
export async function currentBranch(rootDir: string): Promise<string> {
	const { stdout } = await execFile("git", [
		"-C",
		rootDir,
		"rev-parse",
		"--abbrev-ref",
		"HEAD",
	]);
	return stdout.trim();
}

export interface GitRepoInfo {
	branch: string;
	dirty: boolean;
}

// ---------------------------------------------------------------------------
// Read-only history / diff / branch helpers
// ---------------------------------------------------------------------------

export interface GitCommit {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	date: string; // ISO 8601
}

/** Return up to `limit` commits that touched `filePath` inside `repoDir`. */
export async function gitFileHistory(
	repoDir: string,
	filePath: string,
	limit = 50,
): Promise<GitCommit[]> {
	const SEP = "\x1f";
	const { stdout } = await execFile("git", [
		"-C", repoDir,
		"log",
		"--follow",
		`--max-count=${limit}`,
		`--pretty=format:%H${SEP}%s${SEP}%an${SEP}%aI`,
		"--",
		filePath,
	]);
	if (!stdout.trim()) return [];
	return stdout.trim().split("\n").map((line) => {
		const parts = line.split(SEP);
		const sha = (parts[0] ?? "").trim();
		return {
			sha,
			shortSha: sha.slice(0, 7),
			message: (parts[1] ?? "").trim(),
			author: (parts[2] ?? "").trim(),
			date: (parts[3] ?? "").trim(),
		};
	});
}

/**
 * Return unified diff for a single commit affecting `filePath`.
 * Falls back to `git show` for the initial commit (no parent).
 */
export async function gitFileDiff(
	repoDir: string,
	filePath: string,
	sha: string,
): Promise<string> {
	try {
		const { stdout } = await execFile("git", [
			"-C", repoDir,
			"diff",
			`${sha}^`,
			sha,
			"--",
			filePath,
		]);
		return stdout;
	} catch {
		const { stdout } = await execFile("git", [
			"-C", repoDir,
			"show",
			sha,
			"--",
			filePath,
		]);
		return stdout;
	}
}

export interface GitFileInfo {
	sha: string;
	author: string;
	date: string; // ISO 8601
}

/** Return metadata for the last commit that touched `filePath`. */
export async function gitFileInfo(
	repoDir: string,
	filePath: string,
): Promise<GitFileInfo | null> {
	const SEP = "\x1f";
	try {
		const { stdout } = await execFile("git", [
			"-C", repoDir,
			"log", "-1",
			`--pretty=format:%H${SEP}%an${SEP}%aI`,
			"--",
			filePath,
		]);
		if (!stdout.trim()) return null;
		const parts = stdout.trim().split(SEP);
		return {
			sha: (parts[0] ?? "").trim(),
			author: (parts[1] ?? "").trim(),
			date: (parts[2] ?? "").trim(),
		};
	} catch {
		return null;
	}
}

export interface GitBranch {
	name: string;
	current: boolean;
}

/** List local branches in `repoDir`. */
export async function gitBranches(repoDir: string): Promise<GitBranch[]> {
	const { stdout } = await execFile("git", ["-C", repoDir, "branch"]);
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => ({
			current: line.startsWith("*"),
			name: line.replace(/^\*?\s+/, "").trim(),
		}));
}

/** Validate a local branch name before passing it to git. */
function isValidBranchName(name: string): boolean {
	if (!name || name.length > 200) return false;
	if (FORBIDDEN_CHARS.test(name)) return false;
	if (name.includes("..")) return false;
	if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
	if (!/^[a-zA-Z0-9._\-/]+$/.test(name)) return false;
	return true;
}

/**
 * Checkout `branch` in `repoDir`.
 * Throws with `.dirty = true` if the working tree has uncommitted changes.
 * Throws with `.invalidBranch = true` for bad branch names.
 */
export async function gitCheckout(
	repoDir: string,
	branch: string,
): Promise<{ branch: string; sha: string }> {
	if (!isValidBranchName(branch)) {
		const err = new Error("Invalid branch name") as Error & { invalidBranch?: boolean };
		err.invalidBranch = true;
		throw err;
	}
	const { stdout: statusOut } = await execFile("git", [
		"-C", repoDir, "status", "--porcelain",
	]);
	if (statusOut.trim().length > 0) {
		const err = new Error("Repository has uncommitted changes") as Error & { dirty?: boolean };
		err.dirty = true;
		throw err;
	}
	await execFile("git", ["-C", repoDir, "checkout", branch]);
	const [sha, br] = await Promise.all([headSha(repoDir), currentBranch(repoDir)]);
	return { sha, branch: br };
}

/**
 * List branch names on the remote (`git ls-remote --heads`). Works on shallow
 * single-branch clones where local refs only cover the checked-out branch.
 */
export async function gitRemoteBranches(
	repoDir: string,
	auth: { token?: string; username?: string } = {},
): Promise<string[]> {
	const args = ["-C", repoDir, "ls-remote", "--heads", "origin"];
	let askpassPath: string | undefined;
	try {
		let stdout: string;
		if (auth.token) {
			const a = await buildAuthEnv(auth.token);
			askpassPath = a.askpassPath;
			({ stdout } = await execFile("git", args, { env: a.env }));
		} else {
			({ stdout } = await execFile("git", args, {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			}));
		}
		return stdout
			.split("\n")
			.map((l) => l.replace(/^.*\trefs\/heads\//, "").trim())
			.filter(Boolean);
	} finally {
		if (askpassPath) removeAskpassScript(askpassPath);
	}
}

/**
 * Switch a (possibly shallow single-branch) clone to `branch`: fetch it, hard
 * checkout, and wire up tracking so later `git pull --ff-only` works.
 * Throws with `.invalidBranch = true` for bad names.
 */
export async function gitSwitchBranch(
	repoDir: string,
	branch: string,
	auth: { token?: string; username?: string } = {},
): Promise<{ branch: string; sha: string }> {
	if (!isValidBranchName(branch)) {
		const err = new Error("Invalid branch name") as Error & { invalidBranch?: boolean };
		err.invalidBranch = true;
		throw err;
	}
	let askpassPath: string | undefined;
	try {
		let env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
		if (auth.token) {
			const a = await buildAuthEnv(auth.token);
			askpassPath = a.askpassPath;
			env = a.env;
		}
		await execFile("git", ["-C", repoDir, "fetch", "--depth", "1", "origin", branch], { env });
		await execFile("git", ["-C", repoDir, "checkout", "-B", branch, "FETCH_HEAD"]);
		await execFile("git", ["-C", repoDir, "config", `branch.${branch}.remote`, "origin"]);
		await execFile("git", ["-C", repoDir, "config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
	} finally {
		if (askpassPath) removeAskpassScript(askpassPath);
	}
	const [sha, br] = await Promise.all([headSha(repoDir), currentBranch(repoDir)]);
	return { sha, branch: br };
}

/**
 * Walk up from `relFilePath` inside `rootDir`, looking for a git repo root.
 * Returns `{ repoDir, relFromRepo }` for the nearest enclosing repo, or null.
 */
export async function findEnclosingGitRepo(
	rootDir: string,
	relFilePath: string,
): Promise<{ repoDir: string; relFromRepo: string } | null> {
	const parts = relFilePath.split("/").filter(Boolean);
	for (let depth = parts.length - 1; depth >= 0; depth--) {
		const candidate =
			depth === 0 ? rootDir : path.join(rootDir, ...parts.slice(0, depth));
		const gitInfo = await detectGitRepo(candidate);
		if (gitInfo) {
			const relFromRepo = parts.slice(depth).join("/");
			return { repoDir: candidate, relFromRepo };
		}
	}
	return null;
}

/**
 * Check if a directory is a git repo root and return branch + dirty status.
 * Returns null if dirPath is not a git repo root.
 */
export async function detectGitRepo(
	dirPath: string,
): Promise<GitRepoInfo | null> {
	try {
		// stat .git (file for submodules, dir for regular repos)
		await stat(path.join(dirPath, ".git"));
	} catch {
		return null;
	}

	try {
		// Verify it's the repo root, not inside a submodule
		const { stdout: toplevel } = await execFile("git", [
			"-C",
			dirPath,
			"rev-parse",
			"--show-toplevel",
		]);
		if (toplevel.trim() !== dirPath) return null;

		const branch = await currentBranch(dirPath);

		const { stdout: statusOut } = await execFile("git", [
			"-C",
			dirPath,
			"status",
			"--porcelain",
		]);
		const dirty = statusOut.trim().length > 0;

		return { branch, dirty };
	} catch {
		return null;
	}
}
