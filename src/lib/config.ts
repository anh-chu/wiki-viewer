import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Workspace type is defined in workspaces.ts; we use a forward-compatible
// inline shape here to avoid a circular import between config ↔ workspaces.
export interface WorkspaceGitEntry {
	remoteUrl: string;
	branch?: string;
	tokenRef?: string;
	username?: string;
	lastPulledAt?: string;
	lastSha?: string;
	lastError?: string;
	/** Sparse-checkout cone path (e.g. "docs"). rootDir points here inside the clone. */
	subpath?: string;
	/** Absolute path of the clone root. rootDir may differ when subpath is set. */
	cloneRoot?: string;
}

export interface WorkspaceEntry {
	id: string;
	name: string;
	rootDir: string;
	createdAt: string;
	lastOpenedAt?: string;
	pinnedPaths?: string[];
	createdBy?: string;
	allowedUserIds?: string[];
	readOnly?: boolean;
	git?: WorkspaceGitEntry;
}

export interface WikiViewerConfig {
	pinnedPaths?: string[];
	lastOpenedPath?: string;
	/** Email allowlist for signup. Empty/undefined = no email restriction. */
	allowedEmails?: string[];
	/** Domain allowlist for signup. Empty/undefined = no domain restriction. */
	allowedDomains?: string[];
	/** Registered workspaces (replaces flat lastOpenedPath/pinnedPaths over time). */
	workspaces?: WorkspaceEntry[];
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
	await mkdir(path.join(os.homedir(), ".wiki-viewer"), { recursive: true });
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
	await writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
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
