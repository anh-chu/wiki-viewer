/**
 * Branch management for a git-backed workspace.
 *
 * GET  /api/system/workspaces/[id]/branch  — admin-only: list remote branches.
 * POST /api/system/workspaces/[id]/branch  — admin-only: switch to { branch }.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireAdmin } from "@/lib/auth/admin";
import { listGitWorkspaceBranches, switchGitWorkspaceBranch } from "@/lib/workspaces";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const { id } = await params;
	try {
		const branches = await listGitWorkspaceBranches(id);
		return NextResponse.json({ ok: true, branches });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: msg }, { status: 400 });
	}
}

export async function POST(request: Request, { params }: Params) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const { id } = await params;
	const body: { branch?: string } | null = await request.json().catch(() => null);
	if (!body?.branch || typeof body.branch !== "string")
		return NextResponse.json({ error: "Invalid branch" }, { status: 400 });

	try {
		const result = await switchGitWorkspaceBranch(id, body.branch);
		return NextResponse.json({ ok: true, ...result });
	} catch (err) {
		if (err instanceof Error && (err as Error & { invalidBranch?: boolean }).invalidBranch)
			return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
		const msg = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: msg }, { status: 400 });
	}
}
