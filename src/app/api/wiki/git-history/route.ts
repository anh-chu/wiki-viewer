import { NextResponse } from "next/server";
import { findEnclosingGitRepo, gitFileHistory } from "@/lib/git";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	if (!rel) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const filePath = safeWorkspacePath(rootDir, rel);
	if (!filePath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const repo = await findEnclosingGitRepo(rootDir, rel);
	if (!repo) return NextResponse.json({ commits: [] });

	try {
		const commits = await gitFileHistory(repo.repoDir, repo.relFromRepo);
		return NextResponse.json({ commits });
	} catch {
		return NextResponse.json({ commits: [] });
	}
}
