/**
 * POST /api/system/workspaces/[id]/open
 *
 * Client calls this when switching to a workspace.  Records lastOpenedAt so
 * the most-recently-used workspace can be selected on next load.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/admin";
import { getWorkspace, touchWorkspace, userCanAccess } from "@/lib/workspaces";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
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

	await touchWorkspace(id);
	return NextResponse.json({ ok: true });
}
