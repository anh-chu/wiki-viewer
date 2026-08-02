import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PersistedWorkspace } from "@/types/workspace";

export interface WikiViewerConfig {
	pinnedPaths?: string[];
	lastOpenedPath?: string;
	/** Email allowlist for signup. Empty/undefined = no email restriction. */
	allowedEmails?: string[];
	/** Domain allowlist for signup. Empty/undefined = no domain restriction. */
	allowedDomains?: string[];
	/** Registered workspaces (replaces flat lastOpenedPath/pinnedPaths over time). */
	workspaces?: PersistedWorkspace[];
	/** User IDs with admin privileges. Empty = no admins yet (bootstrap on first request). */
	adminUserIds?: string[];
	/** Git-backed workspace host policy. */
	git?: {
		allowedHosts?: string[];
		allowInsecureHttp?: boolean;
	};
}

function configPath() {
	return path.join(os.homedir(), ".wiki-viewer", "config.json");
}

/** Absolute path to the managed git clone directory. */
export function reposDir(): string {
	return path.join(os.homedir(), ".wiki-viewer", "repos");
}

async function ensureDir() {
	const dir = path.join(os.homedir(), ".wiki-viewer");
	// 0700 on the DIRECTORY is the durable fix for secret exposure in here.
	// Per-file modes are whack-a-mole: this dir also holds auth.db (sessions,
	// created by better-auth, not us), *.db-wal/-shm, and timestamped .bak files
	// written by migrations — all of which land 0644 and none of which we own the
	// write path for. Denying traversal covers every one of them, present and
	// future. `mode` is create-only, so chmod fixes dirs from earlier builds.
	await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		await chmod(dir, 0o700);
	} catch {
		// best-effort (read-only fs, foreign owner)
	}
}

export async function readConfig(): Promise<WikiViewerConfig> {
	try {
		const raw = await readFile(configPath(), "utf8");
		return JSON.parse(raw) as WikiViewerConfig;
	} catch {
		return {};
	}
}

// Serialize all writes so concurrent read-modify-write callers can't lose
// updates (workspace mutations, admin bootstrap all race on one file).
let _writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const run = _writeChain.then(fn, fn);
	// Keep the chain alive but swallow errors so one failure doesn't poison it.
	_writeChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function writeConfigUnsafe(next: WikiViewerConfig): Promise<void> {
	await ensureDir();
	// 0600: this file holds secrets (oauth client secret, workspace tokenRefs),
	// so it gets the same treatment as api-key / owner.token / auth.secret.
	// `mode` only applies when creating, hence the explicit chmod for configs
	// that already exist from a build that wrote them 0664.
	await writeFile(configPath(), JSON.stringify(next, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		await chmod(configPath(), 0o600);
	} catch {
		// best-effort (e.g. read-only fs, foreign owner)
	}
}

export async function writeConfig(patch: Partial<WikiViewerConfig>): Promise<void> {
	return serialize(async () => {
		const existing = await readConfig();
		await writeConfigUnsafe({ ...existing, ...patch });
	});
}

/**
 * Atomic read-modify-write. The mutator receives a fresh copy of the config
 * (read inside the lock) and returns the next config. Serialized against all
 * other writeConfig/updateConfig callers so updates are never lost.
 */
export async function updateConfig(
	mutator: (cfg: WikiViewerConfig) => WikiViewerConfig,
): Promise<WikiViewerConfig> {
	return serialize(async () => {
		const existing = await readConfig();
		const next = mutator({ ...existing });
		await writeConfigUnsafe(next);
		return next;
	});
}
