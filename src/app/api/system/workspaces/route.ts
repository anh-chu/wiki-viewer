/**
 * Workspace management API — list and create.
 *
 * GET  /api/system/workspaces  — any signed-in user; returns workspaces the
 *                                caller can access + isAdmin flag.
 * POST { rootDir, name? }      — admin-only: create a new workspace.
 *
 * Bootstrap: first authenticated request triggers ensureBootstrapAdmin.
 */
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { isAdmin, requireAdmin, ensureBootstrapAdmin } from "@/lib/auth/admin";
import { readConfig } from "@/lib/config";
import {
	listWorkspaces,
	createWorkspace,
	createGitWorkspace,
	migrateConfigToWorkspaces,
	userCanAccess,
	sanitizeWorkspace,
} from "@/lib/workspaces";

export const runtime = "nodejs";

export async function GET(request: Request) {
	// --no-auth bypass: single-user local mode has no session. Treat the local
	// user as admin so workspace management (add/delete) is available, matching
	// requireAdmin and resolveWorkspaceForUser.
	if (process.env.WIKI_NO_AUTH === "1") {
		await migrateConfigToWorkspaces();
		const workspaces = (await listWorkspaces()).map(sanitizeWorkspace);
		return NextResponse.json({ workspaces, isAdmin: true });
	}

	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	// Bootstrap: first authenticated user becomes admin if no admin set yet.
	await ensureBootstrapAdmin(auth.user.id);
	await migrateConfigToWorkspaces();

	const admin = await isAdmin(auth.user.id, auth.user.email);
	const all = await listWorkspaces();
	const workspaces = all
		.filter((ws) => userCanAccess(ws, auth.user.id, admin))
		.map(sanitizeWorkspace);

	return NextResponse.json({ workspaces, isAdmin: admin });
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const body: {
		rootDir?: string;
		name?: string;
		remoteUrl?: string;
		branch?: string;
		token?: string;
		username?: string;
	} = await request.json();

	// Git-backed workspace path
	if (body.remoteUrl) {
		const cfg = await readConfig();
		try {
			const workspace = await createGitWorkspace({
				remoteUrl: body.remoteUrl,
				branch: body.branch?.trim() || undefined,
				token: body.token || undefined,
				username: body.username?.trim() || undefined,
				name: body.name?.trim() || undefined,
				createdBy: authResult.user.id,
				allowedHosts: cfg.git?.allowedHosts,
				allowInsecureHttp: cfg.git?.allowInsecureHttp,
			});
			// Never echo token in response; sanitizeWorkspace strips tokenRef.
			return NextResponse.json({ ok: true, workspace: sanitizeWorkspace(workspace) });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return NextResponse.json({ error: msg }, { status: 400 });
		}
	}

	// Plain local workspace path
	const rootDir = body.rootDir?.trim();
	if (!rootDir) return NextResponse.json({ error: "Missing rootDir" }, { status: 400 });

	// Validate directory
	try {
		const info = await stat(rootDir);
		if (!info.isDirectory())
			return NextResponse.json({ error: "Not a directory" }, { status: 400 });
	} catch {
		return NextResponse.json({ error: "Directory not found" }, { status: 404 });
	}

	const workspace = await createWorkspace({
		rootDir,
		name: body.name?.trim() || undefined,
		createdBy: authResult.user.id,
	});

	return NextResponse.json({ ok: true, workspace: sanitizeWorkspace(workspace) });
}
