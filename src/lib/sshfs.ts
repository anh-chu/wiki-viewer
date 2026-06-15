/**
 * SSHFS mount manager.
 *
 * Mounts a remote directory over SSH (sshfs / FUSE) and presents it as a local
 * path, so every existing node:fs-based feature (browse, view, edit, agent
 * tier-1/2, upload, search index, write-locks) works unchanged — no local clone.
 *
 * Mounts live under ~/.wiki-viewer/mounts/<workspaceId>.
 * Auth methods:
 *   - "agent":    ssh-agent / default host keys (~/.ssh/id_*).
 *   - "keyfile":  an explicit private key path (IdentityFile + IdentitiesOnly).
 *   - "password": piped to sshfs via -o password_stdin (never on argv / ps).
 *
 * Security: sshfs is spawned with execFile/spawn (no shell), and every
 * user-supplied field (host, user, remote path, key path) is validated against
 * shell/control metacharacters as defense-in-depth.
 */
import { spawn } from "node:child_process";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rmdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFile = promisify(_execFile);

// Defense-in-depth: reject these even though we never pass through a shell.
const FORBIDDEN_CHARS = /[;|&$`<>(){}\n\r\0]/;

export type SshAuthMethod = "agent" | "keyfile" | "password";

export interface ParsedSshTarget {
	user?: string;
	host: string;
	remotePath: string;
}

/** Absolute path to the managed sshfs mount directory. */
export function mountsDir(): string {
	return path.join(os.homedir(), ".wiki-viewer", "mounts");
}

/** Mount point for a given workspace id. */
export function mountpointFor(id: string): string {
	return path.join(mountsDir(), id);
}

// ── Availability ─────────────────────────────────────────────────────────────

let _sshfsAvailable: boolean | undefined;

/** Verify the sshfs binary exists. Throws a friendly error if not. Cached. */
export async function assertSshfsAvailable(): Promise<void> {
	if (_sshfsAvailable === true) return;
	try {
		// sshfs --version exits 0 and prints version on all platforms.
		await execFile("sshfs", ["--version"]);
		_sshfsAvailable = true;
	} catch {
		throw new Error(
			"sshfs binary not found. Install sshfs + FUSE (e.g. `apt install sshfs`, " +
				"`brew install macfuse sshfs`) and ensure it is on PATH.",
		);
	}
}

// ── Parse / validate ─────────────────────────────────────────────────────────

/**
 * Parse an SSH target of the form `[user@]host:/abs/path`.
 * Returns null if it does not match or contains forbidden characters.
 */
export function parseSshTarget(target: string): ParsedSshTarget | null {
	if (!target || FORBIDDEN_CHARS.test(target)) return null;
	const trimmed = target.trim();

	// Split host part from the remote path on the FIRST ":" that is not part of
	// the userinfo. Format: [user@]host:/path  (path must be absolute).
	const colon = trimmed.indexOf(":");
	if (colon <= 0) return null;
	const hostPart = trimmed.slice(0, colon);
	const remotePath = trimmed.slice(colon + 1);

	if (!remotePath.startsWith("/")) return null;
	if (remotePath.includes("..")) return null;

	let user: string | undefined;
	let host = hostPart;
	const at = hostPart.indexOf("@");
	if (at >= 0) {
		user = hostPart.slice(0, at);
		host = hostPart.slice(at + 1);
		if (!user) return null;
	}
	if (!host) return null;
	// Host: letters, digits, dots, hyphens, colons (IPv6 not supported here).
	if (!/^[a-zA-Z0-9.\-]+$/.test(host)) return null;
	// User: typical unix username charset.
	if (user && !/^[a-zA-Z0-9._\-]+$/.test(user)) return null;

	return { user, host, remotePath };
}

/** Validate an explicit private key path (no metachars, absolute or ~). */
export function isValidKeyPath(keyPath: string): boolean {
	if (!keyPath || FORBIDDEN_CHARS.test(keyPath)) return false;
	if (keyPath.includes("..")) return false;
	return keyPath.startsWith("/") || keyPath.startsWith("~/");
}

// ── Mount state ──────────────────────────────────────────────────────────────

/**
 * True if `mountpoint` is currently a live sshfs mount.
 * Checks the kernel mount table first (cheap, no network), then does a bounded
 * liveness probe so a stale/hung mount reads as NOT mounted (triggers remount).
 */
export async function isMounted(mountpoint: string): Promise<boolean> {
	const resolved = path.resolve(mountpoint);
	let inTable = false;
	try {
		if (process.platform === "linux") {
			const mounts = await readFile("/proc/mounts", "utf8");
			inTable = mounts.split("\n").some((line) => {
				const parts = line.split(" ");
				return parts[1] === resolved && /fuse/.test(parts[2] ?? "");
			});
		} else {
			// macOS / other: parse `mount` output.
			const { stdout } = await execFile("mount", []);
			inTable = stdout.split("\n").some((l) => l.includes(` on ${resolved} `));
		}
	} catch {
		inTable = false;
	}
	if (!inTable) return false;

	// Liveness probe with timeout: a stale sshfs mount hangs on stat.
	return probeLive(resolved, 4000);
}

/** readdir the mount with a hard timeout. Resolves false on hang/error. */
function probeLive(dir: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				resolve(false);
			}
		}, timeoutMs);
		import("node:fs/promises")
			.then(({ readdir }) => readdir(dir))
			.then(() => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(true);
				}
			})
			.catch(() => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(false);
				}
			});
	});
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

export interface MountOptions {
	mountpoint: string;
	target: ParsedSshTarget;
	port?: number;
	authMethod: SshAuthMethod;
	/** Private key path (authMethod="keyfile"). */
	keyPath?: string;
	/** Password (authMethod="password"); piped via stdin, never on argv. */
	password?: string;
	readOnly?: boolean;
	/** Extra ssh/sshfs -o options (advanced). */
	extraOptions?: string[];
}

/** Build the sshfs argv (excluding the binary name). Exported for testing. */
export function buildSshfsArgs(opts: MountOptions): string[] {
	const { target, mountpoint, port, authMethod, keyPath, readOnly } = opts;
	const userPart = target.user ? `${target.user}@` : "";
	const args: string[] = [
		`${userPart}${target.host}:${target.remotePath}`,
		mountpoint,
	];
	if (port && Number.isInteger(port) && port > 0 && port < 65536) {
		args.push("-p", String(port));
	}

	const o: string[] = [
		"reconnect",
		"ServerAliveInterval=15",
		"ServerAliveCountMax=3",
		"compression=yes",
		"cache=yes",
		"kernel_cache",
		"StrictHostKeyChecking=accept-new",
		"BatchMode=yes",
	];
	if (readOnly) o.push("ro");
	if (authMethod === "keyfile" && keyPath) {
		o.push(`IdentityFile=${keyPath}`);
		o.push("IdentitiesOnly=yes");
	}
	if (authMethod === "password") {
		// Remove BatchMode (forces password prompt off) and feed via stdin.
		const idx = o.indexOf("BatchMode=yes");
		if (idx >= 0) o.splice(idx, 1);
		o.push("password_stdin");
		o.push("PreferredAuthentications=password,keyboard-interactive");
		o.push("PubkeyAuthentication=no");
		o.push("NumberOfPasswordPrompts=1");
	}
	if (opts.extraOptions) o.push(...opts.extraOptions);

	args.push("-o", o.join(","));
	return args;
}

/**
 * Mount a remote directory at `opts.mountpoint`. Creates the mount dir.
 * Resolves on success; rejects with the sshfs stderr on failure.
 */
export async function mountSshfs(opts: MountOptions): Promise<void> {
	await assertSshfsAvailable();
	await mkdir(opts.mountpoint, { recursive: true });

	const args = buildSshfsArgs(opts);

	await new Promise<void>((resolve, reject) => {
		const child = spawn("sshfs", args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("sshfs mount timed out after 25s."));
		}, 25_000);

		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(
				err.message.includes("ENOENT")
					? new Error("sshfs binary not found on PATH.")
					: err,
			);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`sshfs exited ${code}: ${stderr.trim() || "mount failed"}`,
					),
				);
		});

		// Feed the password (newline-terminated) when using password_stdin.
		if (opts.authMethod === "password") {
			child.stdin?.write((opts.password ?? "") + "\n");
		}
		child.stdin?.end();
	});

	// sshfs daemonizes once the mount is up; confirm it really mounted.
	if (!(await isMounted(opts.mountpoint))) {
		throw new Error("sshfs reported success but the mount is not live.");
	}
}

/** Unmount `mountpoint`. Best-effort; removes the (now empty) mount dir. */
export async function unmountSshfs(mountpoint: string): Promise<void> {
	const resolved = path.resolve(mountpoint);
	const tries: [string, string[]][] =
		process.platform === "linux"
			? [
					["fusermount", ["-u", "-z", resolved]],
					["umount", [resolved]],
				]
			: [
					["umount", [resolved]],
					["diskutil", ["unmount", "force", resolved]],
				];
	for (const [bin, args] of tries) {
		try {
			await execFile(bin, args);
			break;
		} catch {
			// try next strategy
		}
	}
	// Remove the empty mount dir (no-op if non-empty / busy).
	try {
		await rmdir(resolved);
	} catch {
		// best-effort
	}
}
