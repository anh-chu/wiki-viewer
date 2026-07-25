/**
 * Request-scoped workspace resolution for browser/session routes.
 *
 * Determines which workspace a request targets and enforces access control.
 * Phase B routes call this instead of getRootDir().
 */

import path from "node:path";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { requireUser } from "@/lib/auth/server";
import { isApiKeyRequest } from "@/lib/auth/api-key";
import { isAdmin } from "@/lib/auth/admin";
import { getRootDir } from "@/lib/root-dir";
import {
	getWorkspace,
	listWorkspaces,
	userCanAccess,
	migrateConfigToWorkspaces,
	ensureWorkspaceMounted,
	type Workspace,
} from "@/lib/workspaces";

/**
 * Synthetic fallback workspace built from the legacy process-global rootDir
 * (root-dir.ts). Used only when the registry has no workspaces — keeps the
 * ROOT_DIR / CLI / test paths working until Phase E removes the global.
 * Returns null when no global root is set either.
 */
function fallbackWorkspace(): Workspace | null {
	const root = getRootDir();
	if (!root) return null;
	return {
		id: "ws_default",
		name: path.basename(root) || "workspace",
		rootDir: root,
		createdAt: new Date(0).toISOString(),
	};
}

/**
 * Synthetic, request-scoped workspace for a host-supplied `?root=` (termyard
 * embed). Same in-memory-only shape as fallbackWorkspace(): never written to
 * the registry, never the active workspace, never in the switcher. The id is
 * derived from the path so it's stable across requests for the same root
 * without ever being allocated or stored.
 */
function ephemeralWorkspace(rootDir: string): Workspace {
	const digest = createHash("sha256").update(rootDir).digest("hex").slice(0, 12);
	return {
		id: `ws_eph_${digest}`,
		name: path.basename(rootDir) || "workspace",
		rootDir,
		createdAt: new Date(0).toISOString(),
		ephemeral: true,
	};
}

/**
 * Resolve a host-supplied `?root=<abs path>` into an ephemeral workspace.
 *
 * GATE: API-key auth only — NOT `?embed=1`. `embed=1` is not a security
 * boundary: middleware falls through to the ordinary session-cookie check when
 * the key is missing/invalid, so any signed-in user can append it. And a
 * synthetic workspace has no `allowedUserIds`, which userCanAccess() treats as
 * "any signed-in user may access" — so gating on embed=1 would let any
 * non-admin escape their workspace ACL and read anything this process can.
 *
 * The API key (mode 0600 at ~/.wiki-viewer/api-key) is the right boundary:
 * whoever can read it already has this process's filesystem access, so an
 * arbitrary root grants no new privilege.
 *
 * Failures are LOUD (400 + machine-readable code) rather than falling back to
 * the default workspace — a silent fallback would render the wrong file or an
 * empty tree, which is the exact bug this feature exists to fix.
 */
async function resolveEphemeralRoot(
	req: Request,
	rootParam: string,
): Promise<PickResult> {
	// WIKI_NO_AUTH=1 is a total dev/CI bypass, so honor root there too.
	const authorized = process.env.WIKI_NO_AUTH === "1" || isApiKeyRequest(req);
	if (!authorized) {
		return { ok: false, status: 400, code: "root_requires_api_key" };
	}

	const resolved = path.resolve(rootParam);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(resolved);
	} catch {
		return { ok: false, status: 400, code: "root_not_found" };
	}
	if (!info.isDirectory()) {
		return { ok: false, status: 400, code: "root_not_a_directory" };
	}

	return { ok: true, ws: ephemeralWorkspace(resolved) };
}

type PickResult = { ok: true; ws: Workspace } | WorkspaceError;

/**
 * Resolve the target workspace from the request alone (no auth/access check,
 * except the API-key gate on `?root=`).
 * Selection: ?root= (ephemeral, api-key gated) → ?ws= query → x-workspace
 * header → most-recent lastOpenedAt → synthetic fallback from the global
 * rootDir.
 */
async function pickWorkspace(req: Request): Promise<PickResult> {
	await migrateConfigToWorkspaces();
	const url = new URL(req.url);

	// Host-supplied ephemeral root takes precedence over all registry lookup.
	const rootParam = url.searchParams.get("root");
	if (rootParam) return resolveEphemeralRoot(req, rootParam);

	const wsId = url.searchParams.get("ws") ?? req.headers.get("x-workspace") ?? null;
	let ws: Workspace | null;
	if (wsId) {
		ws = (await getWorkspace(wsId)) ?? null;
	} else {
		const all = await listWorkspaces();
		if (all.length === 0) {
			ws = fallbackWorkspace();
		} else {
			ws = all
				.slice()
				.sort((a, b) => {
					const ta = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
					const tb = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
					if (tb !== ta) return tb - ta;
					return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
				})[0];
		}
	}

	if (!ws) {
		return {
			ok: false,
			status: wsId ? 404 : 400,
			code: wsId ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_REQUIRED",
		};
	}

	// Lazy remount for sshfs-backed workspaces: handles server restart and
	// stale-mount recovery uniformly, right before the request touches the fs.
	if (ws.ssh) await ensureWorkspaceMounted(ws);
	return { ok: true, ws };
}

export interface WorkspaceContext {
	ok: true;
	ws: Workspace;
	rootDir: string;
	userId: string;
	isAdmin: boolean;
}

export interface WorkspaceError {
	ok: false;
	status: number;
	code: string;
}

/**
 * Resolves the workspace for a browser/session request.
 *
 * Selection order:
 *   1. `?ws=<id>` query param (preferred).
 *   2. `x-workspace` header.
 *   3. Fall back to the workspace with the most recent lastOpenedAt.
 *      If exactly one workspace exists, use it.
 *      If zero workspaces -> 400 WORKSPACE_REQUIRED.
 *
 * Pass intent="write" on any route that mutates the filesystem.
 * Returns 403 WORKSPACE_READ_ONLY for write intent on a readOnly workspace.
 */
export async function resolveWorkspaceForUser(
	req: Request,
	intent: "read" | "write" = "read",
): Promise<WorkspaceContext | WorkspaceError> {
	// --no-auth bypass
	if (process.env.WIKI_NO_AUTH === "1") {
		const picked = await pickWorkspace(req);
		if (!picked.ok) return picked;
		const { ws } = picked;
		if (intent === "write" && ws.readOnly) {
			return { ok: false, status: 403, code: "WORKSPACE_READ_ONLY" };
		}
		return { ok: true, ws, rootDir: ws.rootDir, userId: "local", isAdmin: true };
	}

	// Authenticate
	const auth = await requireUser(req);
	if (!auth.ok) return { ok: false, status: 401, code: "UNAUTHORIZED" };

	const admin = await isAdmin(auth.user.id, auth.user.email);

	const picked = await pickWorkspace(req);
	if (!picked.ok) return picked;
	const { ws } = picked;

	// Ephemeral roots are already gated on API-key auth in resolveEphemeralRoot,
	// which is a strictly stronger check than the workspace ACL. Skipping it
	// explicitly rather than relying on userCanAccess()'s "empty allowedUserIds
	// = everyone passes" default, which would be an accidental pass here.
	if (!ws.ephemeral && !userCanAccess(ws, auth.user.id, admin)) {
		return { ok: false, status: 403, code: "WORKSPACE_FORBIDDEN" };
	}

	if (intent === "write" && ws.readOnly) {
		return { ok: false, status: 403, code: "WORKSPACE_READ_ONLY" };
	}

	return { ok: true, ws, rootDir: ws.rootDir, userId: auth.user.id, isAdmin: admin };
}

export interface AgentWorkspaceContext {
	ok: true;
	ws: Workspace;
	rootDir: string;
}

/**
 * Resolve the target workspace for an AUTHENTICATED agent request.
 *
 * Phase B: resolution only (no per-agent workspace grant check - that is added
 * in Phase C, which will verify the agent's scope.workspaceId === ws.id).
 * Selection mirrors the session resolver: ?ws / x-workspace / default / global.
 *
 * Pass intent="write" on any route that mutates the filesystem.
 * Returns 403 WORKSPACE_READ_ONLY for write intent on a readOnly workspace.
 */
export async function resolveWorkspaceForAgent(
	req: Request,
	intent: "read" | "write" = "read",
): Promise<AgentWorkspaceContext | WorkspaceError> {
	const picked = await pickWorkspace(req);
	if (!picked.ok) return picked;
	const { ws } = picked;
	if (intent === "write" && ws.readOnly) {
		return { ok: false, status: 403, code: "WORKSPACE_READ_ONLY" };
	}
	return { ok: true, ws, rootDir: ws.rootDir };
}
