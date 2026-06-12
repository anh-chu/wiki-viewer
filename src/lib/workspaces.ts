/**
 * Workspace registry — persisted in ~/.wiki-viewer/config.json under `workspaces[]`.
 *
 * Design choice: rootDir is the natural namespace key for in-memory stores
 * (lease, mutex, idempotency).  Each workspace has a stable `id` for URLs and
 * access control.  All mutations read fresh config inside the function to
 * avoid stale in-memory copies.
 */

import path from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { readConfig, updateConfig, reposDir } from "./config";
import {
	assertGitAvailable,
	validateRemoteUrl,
	cloneRepo,
	pullRepo,
	headSha,
	currentBranch,
} from "./git";
import { genTokenRef, setToken, getToken, deleteToken } from "./git-secrets";

export interface WorkspaceGit {
	remoteUrl: string;
	branch?: string;
	tokenRef?: string;
	username?: string;
	lastPulledAt?: string;
	lastSha?: string;
	lastError?: string;
}

export interface Workspace {
	/** "ws_" + 6 random url-safe bytes. Stable, used in ?ws= query param. */
	id: string;
	/** Display label. Defaults to path.basename(rootDir). */
	name: string;
	/** Absolute, path.resolve'd rootDir. */
	rootDir: string;
	createdAt: string;
	lastOpenedAt?: string;
	/** Per-workspace pinned paths (moved from flat config.pinnedPaths). */
	pinnedPaths?: string[];
	/** User id of admin who created this workspace. */
	createdBy?: string;
	/**
	 * Explicit access list.  Empty / undefined = any signed-in user may access.
	 * Admin users always have access regardless of this list.
	 */
	allowedUserIds?: string[];
	/** True for git-backed read-only workspaces. Blocks all fs mutations. */
	readOnly?: boolean;
	/** Git remote metadata. Present only on git-backed workspaces. */
	git?: WorkspaceGit;
}

/**
 * Strip secret-bearing fields before returning a workspace over HTTP.
 * tokenRef is an internal handle into the PAT store and must never leave the
 * server. Use this on every response that includes workspace objects.
 */
export function sanitizeWorkspace(ws: Workspace): Workspace {
	if (!ws.git) return ws;
	const { tokenRef: _omit, ...gitSafe } = ws.git;
	return { ...ws, git: gitSafe };
}

// ── Queries ────────────────────────────────────────────────────────────────────

export async function listWorkspaces(): Promise<Workspace[]> {
	const cfg = await readConfig();
	return (cfg.workspaces ?? []) as Workspace[];
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
	const list = await listWorkspaces();
	return list.find((w) => w.id === id) ?? null;
}

export async function resolveWorkspaceRoot(id: string): Promise<string | null> {
	const ws = await getWorkspace(id);
	return ws?.rootDir ?? null;
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export async function createWorkspace(input: {
	rootDir: string;
	name?: string;
	createdBy?: string;
}): Promise<Workspace> {
	const rootDir = path.resolve(input.rootDir);
	const ws: Workspace = {
		id: "ws_" + randomBytes(6).toString("base64url"),
		name: input.name ?? path.basename(rootDir),
		rootDir,
		createdAt: new Date().toISOString(),
		lastOpenedAt: new Date().toISOString(),
		createdBy: input.createdBy,
	};
	await updateConfig((cfg) => ({
		...cfg,
		workspaces: [...((cfg.workspaces ?? []) as Workspace[]), ws],
	}));
	return ws;
}

export async function createGitWorkspace(input: {
	remoteUrl: string;
	branch?: string;
	token?: string;
	username?: string;
	name?: string;
	createdBy?: string;
	allowedHosts?: string[];
	allowInsecureHttp?: boolean;
	/** Internal: skip URL scheme validation (e.g. local filesystem path in tests). */
	allowLocalPath?: boolean;
}): Promise<Workspace> {
	await assertGitAvailable();

	if (!input.allowLocalPath) {
		const check = validateRemoteUrl(input.remoteUrl, {
			allowedHosts: input.allowedHosts,
			allowInsecureHttp: input.allowInsecureHttp,
		});
		if (!check.ok) {
			throw new Error(check.reason);
		}
	}

	const id = "ws_" + randomBytes(6).toString("base64url");
	const destDir = path.join(reposDir(), id);

	let tokenRef: string | undefined;
	if (input.token) {
		tokenRef = genTokenRef();
		await setToken(tokenRef, input.token);
	}

	try {
		await cloneRepo({
			remoteUrl: input.remoteUrl,
			branch: input.branch,
			token: input.token,
			username: input.username,
			destDir,
		});
	} catch (err) {
		if (tokenRef) {
			try { await deleteToken(tokenRef); } catch { /* ignore */ }
		}
		try { rmSync(destDir, { recursive: true, force: true }); } catch { /* ignore */ }
		throw err;
	}

	const now = new Date().toISOString();
	const sha = await headSha(destDir);
	const detectedBranch = !input.branch ? await currentBranch(destDir) : undefined;
	const repoName = input.name ??
		path.basename(input.remoteUrl.replace(/\.git$/, ""));

	const ws: Workspace = {
		id,
		name: repoName,
		rootDir: destDir,
		createdAt: now,
		lastOpenedAt: now,
		createdBy: input.createdBy,
		readOnly: true,
		git: {
			remoteUrl: input.remoteUrl,
			branch: input.branch ?? detectedBranch,
			tokenRef,
			username: input.username,
			lastPulledAt: now,
			lastSha: sha,
		},
	};

	await updateConfig((cfg) => ({
		...cfg,
		workspaces: [...((cfg.workspaces ?? []) as Workspace[]), ws],
	}));

	return ws;
}

export async function refreshGitWorkspace(
	id: string,
): Promise<{ lastSha: string; lastPulledAt: string }> {
	const ws = await getWorkspace(id);
	if (!ws) throw new Error(`Workspace ${id} not found`);
	if (!ws.git) throw new Error(`Workspace ${id} is not a git-backed workspace`);

	const token = ws.git.tokenRef ? await getToken(ws.git.tokenRef) ?? undefined : undefined;

	try {
		await pullRepo({ rootDir: ws.rootDir, token, username: ws.git.username });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await mutateWorkspace(id, (w) => ({
			...w,
			git: w.git ? { ...w.git, lastError: msg } : w.git,
		}));
		throw err;
	}

	const sha = await headSha(ws.rootDir);
	const now = new Date().toISOString();
	await mutateWorkspace(id, (w) => ({
		...w,
		git: w.git ? { ...w.git, lastSha: sha, lastPulledAt: now, lastError: undefined } : w.git,
	}));

	return { lastSha: sha, lastPulledAt: now };
}

function mutateWorkspace(
	id: string,
	fn: (w: Workspace) => Workspace,
): Promise<void> {
	return updateConfig((cfg) => {
		const workspaces = ((cfg.workspaces ?? []) as Workspace[]).map((w) =>
			w.id === id ? fn(w) : w,
		);
		return { ...cfg, workspaces };
	}).then(() => undefined);
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
	await mutateWorkspace(id, (w) => ({ ...w, name }));
}

export async function removeWorkspace(id: string): Promise<void> {
	const ws = await getWorkspace(id);
	await updateConfig((cfg) => ({
		...cfg,
		workspaces: ((cfg.workspaces ?? []) as Workspace[]).filter((w) => w.id !== id),
	}));
	// Cleanup git-backed workspace artifacts.
	if (ws?.git?.tokenRef) {
		try { await deleteToken(ws.git.tokenRef); } catch { /* best-effort */ }
	}
	if (ws?.git) {
		// Only remove the clone dir if it is inside the managed repos dir.
		const managed = reposDir();
		if (ws.rootDir.startsWith(managed + path.sep) || ws.rootDir === managed) {
			try { rmSync(ws.rootDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	}
	// Purge search index for the removed workspace. Import dynamically to avoid
	// circular dependency if search modules ever import from workspaces.
	try {
		const { purgeWorkspace } = await import("./search/indexer");
		await purgeWorkspace(id);
	} catch (e) {
		console.error("[search] purge failed on workspace remove", e);
	}
}

export async function setWorkspaceAccess(id: string, userIds: string[]): Promise<void> {
	await mutateWorkspace(id, (w) => ({ ...w, allowedUserIds: userIds }));
}

export async function setWorkspacePins(id: string, pinnedPaths: string[]): Promise<void> {
	await mutateWorkspace(id, (w) => ({ ...w, pinnedPaths }));
}

export async function touchWorkspace(id: string): Promise<void> {
	await mutateWorkspace(id, (w) => ({ ...w, lastOpenedAt: new Date().toISOString() }));
}

// ── Access control ─────────────────────────────────────────────────────────────

/**
 * True if userId may use this workspace.
 * Admin always passes.  If allowedUserIds is empty/undefined, any signed-in user passes.
 */
export function userCanAccess(ws: Workspace, userId: string, isAdmin: boolean): boolean {
	if (isAdmin) return true;
	if (!ws.allowedUserIds || ws.allowedUserIds.length === 0) return true;
	return ws.allowedUserIds.includes(userId);
}

// ── Path safety ────────────────────────────────────────────────────────────────

/**
 * Returns the absolute path for `rel` within `rootDir`, or null on traversal.
 * Replicates root-dir.ts safeRootPath exactly, but takes an explicit rootDir
 * instead of reading the process-global.  Phase B removes safeRootPath in
 * favour of this function.
 */
export function safeWorkspacePath(rootDir: string, rel: string): string | null {
	if (!rootDir) return null;
	if (!rel || rel === ".") return rootDir;
	const resolved = path.resolve(rootDir, rel);
	if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
	return resolved;
}

// ── Migration ──────────────────────────────────────────────────────────────────

// Guard: true once migration has run in this process (cheap fast-path).
let _migrated = false;

/**
 * Idempotent migration: if config.workspaces is absent/empty, synthesise one
 * workspace from the old single-root sources, in priority order:
 *   1. config.lastOpenedPath (existing single-user config)
 *   2. process.env.ROOT_DIR  (CLI / `wiki-viewer <dir>` / service boot)
 * This makes a ROOT_DIR-launched server register a REAL workspace (visible in
 * the switcher) instead of relying only on the synthetic fallback.
 * Does NOT delete the old fields (rollback safety).  Logs once.
 */
export async function migrateConfigToWorkspaces(): Promise<void> {
	if (_migrated) return;

	const seedRoot = (cfg: { lastOpenedPath?: string }): string | null =>
		cfg.lastOpenedPath ??
		(process.env.ROOT_DIR ? path.resolve(process.env.ROOT_DIR) : null);

	// Fast-path read to skip the serialized write when nothing to do.
	const cfg = await readConfig();
	if (((cfg.workspaces ?? []) as Workspace[]).length > 0 || !seedRoot(cfg)) {
		_migrated = true;
		return;
	}

	let created: Workspace | null = null;
	// Atomic: re-check inside the lock so concurrent callers can't both create.
	await updateConfig((fresh) => {
		const existing = (fresh.workspaces ?? []) as Workspace[];
		const seed = seedRoot(fresh);
		if (existing.length > 0 || !seed) return fresh;
		const rootDir = path.resolve(seed);
		created = {
			id: "ws_" + randomBytes(6).toString("base64url"),
			name: path.basename(rootDir),
			rootDir,
			createdAt: new Date().toISOString(),
			lastOpenedAt: new Date().toISOString(),
			pinnedPaths: fresh.pinnedPaths,
		};
		return { ...fresh, workspaces: [created] };
	});
	if (created) {
		console.log(
			`[wiki-viewer] Migrated lastOpenedPath → workspace "${(created as Workspace).name}" (${(created as Workspace).id})`,
		);
	}
	_migrated = true;
}
