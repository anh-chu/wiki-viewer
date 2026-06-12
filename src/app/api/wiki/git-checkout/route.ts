import { NextResponse } from "next/server";
import { detectGitRepo, gitCheckout } from "@/lib/git";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string; branch?: string } = await request.json();
	const rel = body.path;
	const branch = body.branch;

	if (!rel || typeof rel !== "string" || !branch || typeof branch !== "string")
		return NextResponse.json({ error: "Invalid params" }, { status: 400 });

	const repoDir = safeWorkspacePath(rootDir, rel);
	if (!repoDir || repoDir === rootDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	if (!(await detectGitRepo(repoDir)))
		return NextResponse.json({ error: "Not a git repository" }, { status: 400 });

	try {
		const result = await gitCheckout(repoDir, branch);
		return NextResponse.json({ ok: true, ...result });
	} catch (err: unknown) {
		if (err instanceof Error && (err as Error & { dirty?: boolean }).dirty) {
			return NextResponse.json(
				{ error: "DIRTY", message: "Repository has uncommitted changes" },
				{ status: 409 },
			);
		}
		if (err instanceof Error && (err as Error & { invalidBranch?: boolean }).invalidBranch) {
			return NextResponse.json({ error: "Invalid branch name" }, { status: 400 });
		}
		const message = err instanceof Error ? err.message : "Checkout failed";
		return NextResponse.json({ error: "Checkout failed", message }, { status: 500 });
	}
}
