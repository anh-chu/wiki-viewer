/**
 * POST /api/system/workspaces/[id]/refresh
 *
 * Admin-only: pull the latest commit for a git-backed workspace (ff-only).
 * Returns the new HEAD sha and pull time. Never returns any token.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireAdmin } from "@/lib/auth/admin";
import { refreshGitWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const { id } = await params;
	try {
		const result = await refreshGitWorkspace(id);
		return NextResponse.json({ ok: true, ...result });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: msg }, { status: 400 });
	}
}
