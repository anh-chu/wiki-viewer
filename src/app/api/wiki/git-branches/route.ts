import { NextResponse } from "next/server";
import { detectGitRepo, gitBranches } from "@/lib/git";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	if (!rel) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const repoDir = safeWorkspacePath(rootDir, rel);
	if (!repoDir || repoDir === rootDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	if (!(await detectGitRepo(repoDir)))
		return NextResponse.json({ error: "Not a git repository" }, { status: 400 });

	try {
		const branches = await gitBranches(repoDir);
		const current = branches.find((b) => b.current)?.name ?? "";
		return NextResponse.json({ branches, current });
	} catch {
		return NextResponse.json(
			{ error: "Failed to list branches" },
			{ status: 500 },
		);
	}
}
