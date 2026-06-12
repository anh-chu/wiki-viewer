/**
 * Thin wrapper around the system git binary.
 * Provider-agnostic: works with GitHub, GitLab, Bitbucket, Gitea, GHE, etc.
 * Tokens are injected via GIT_ASKPASS so they never appear in process args,
 * .git/config, or ps output.
 */
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, unlinkSync, rmSync, chmodSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
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
}

/** Clone a remote repository. Shallow (depth=1) by default. */
export async function cloneRepo(args: CloneArgs): Promise<void> {
	const { branch, token, destDir } = args;
	const depth = args.depth ?? 1;
	const username = args.username ?? "x-access-token";

	const cloneArgs: string[] = ["clone", "--depth", String(depth)];
	if (branch) {
		cloneArgs.push("--branch", branch, "--single-branch");
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
