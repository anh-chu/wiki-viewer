/**
 * Per-workspace management API.
 *
 * PATCH  /api/system/workspaces/[id]  — update name, pinnedPaths (any user with
 *                                       access), or allowedUserIds (admin-only).
 * DELETE /api/system/workspaces/[id]  — admin-only: remove workspace from registry
 *                                       (never touches the filesystem directory).
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { isAdmin, requireAdmin } from "@/lib/auth/admin";
import {
	getWorkspace,
	renameWorkspace,
	removeWorkspace,
	setWorkspaceAccess,
	setWorkspacePins,
	userCanAccess,
} from "@/lib/workspaces";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const { id } = await params;
	const ws = await getWorkspace(id);
	if (!ws) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });

	const admin = await isAdmin(auth.user.id, auth.user.email);
	if (!userCanAccess(ws, auth.user.id, admin))
		return NextResponse.json({ error: "WORKSPACE_FORBIDDEN" }, { status: 403 });

	const body: {
		name?: string;
		pinnedPaths?: string[];
		allowedUserIds?: string[];
	} = await request.json();

	// allowedUserIds is admin-only
	if (body.allowedUserIds !== undefined && !admin)
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });

	// Apply each field
	if (body.name !== undefined) await renameWorkspace(id, body.name.trim());
	if (body.pinnedPaths !== undefined) await setWorkspacePins(id, body.pinnedPaths);
	if (body.allowedUserIds !== undefined) await setWorkspaceAccess(id, body.allowedUserIds);

	const updated = await getWorkspace(id);
	return NextResponse.json({ ok: true, workspace: updated });
}

export async function DELETE(request: Request, { params }: Params) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const { id } = await params;
	const ws = await getWorkspace(id);
	if (!ws) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });

	await removeWorkspace(id);
	return NextResponse.json({ ok: true });
}
