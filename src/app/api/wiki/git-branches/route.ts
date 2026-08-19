import { NextResponse } from "next/server";
import { detectGitRepo, gitBranches } from "@/lib/git";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	if (!rel) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved || resolved.absolutePath === rootDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	const repoDir = resolved.absolutePath;

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
