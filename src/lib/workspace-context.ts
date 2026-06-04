/**
 * Request-scoped workspace resolution for browser/session routes.
 *
 * Determines which workspace a request targets and enforces access control.
 * Phase B routes call this instead of getRootDir().
 */

import path from "node:path";
import { requireUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/admin";
import { getRootDir } from "@/lib/root-dir";
import {
	getWorkspace,
	listWorkspaces,
	userCanAccess,
	migrateConfigToWorkspaces,
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
 * Resolve the target workspace from the request alone (no auth/access check).
 * Selection: ?ws= query → x-workspace header → most-recent lastOpenedAt →
 * synthetic fallback from the global rootDir. Returns null if nothing resolves.
 */
async function pickWorkspace(req: Request): Promise<Workspace | null> {
	await migrateConfigToWorkspaces();
	const url = new URL(req.url);
	const wsId = url.searchParams.get("ws") ?? req.headers.get("x-workspace") ?? null;
	if (wsId) {
		return (await getWorkspace(wsId)) ?? null;
	}
	const all = await listWorkspaces();
	if (all.length === 0) return fallbackWorkspace();
	return all
		.slice()
		.sort((a, b) => {
			const ta = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
			const tb = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
			if (tb !== ta) return tb - ta;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		})[0];
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
 *      If zero workspaces → 400 WORKSPACE_REQUIRED.
 */
export async function resolveWorkspaceForUser(
	req: Request,
): Promise<WorkspaceContext | WorkspaceError> {
	// Authenticate
	const auth = await requireUser(req);
	if (!auth.ok) return { ok: false, status: 401, code: "UNAUTHORIZED" };

	const admin = await isAdmin(auth.user.id, auth.user.email);
	const url = new URL(req.url);
	const explicitWsId =
		url.searchParams.get("ws") ?? req.headers.get("x-workspace") ?? null;

	const ws = await pickWorkspace(req);
	if (!ws) {
		// No workspace and no global root configured yet.
		return {
			ok: false,
			status: explicitWsId ? 404 : 400,
			code: explicitWsId ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_REQUIRED",
		};
	}

	if (!userCanAccess(ws, auth.user.id, admin)) {
		return { ok: false, status: 403, code: "WORKSPACE_FORBIDDEN" };
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
 * Phase B: resolution only (no per-agent workspace grant check — that is added
 * in Phase C, which will verify the agent's scope.workspaceId === ws.id).
 * Selection mirrors the session resolver: ?ws / x-workspace / default / global.
 */
export async function resolveWorkspaceForAgent(
	req: Request,
): Promise<AgentWorkspaceContext | WorkspaceError> {
	const ws = await pickWorkspace(req);
	if (!ws) {
		const url = new URL(req.url);
		const explicit =
			url.searchParams.get("ws") ?? req.headers.get("x-workspace") ?? null;
		return {
			ok: false,
			status: explicit ? 404 : 400,
			code: explicit ? "WORKSPACE_NOT_FOUND" : "WORKSPACE_REQUIRED",
		};
	}
	return { ok: true, ws, rootDir: ws.rootDir };
}
