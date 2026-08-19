import { NextResponse } from "next/server";
import { findEnclosingGitRepo, gitFileDiff } from "@/lib/git";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	const sha = searchParams.get("sha") ?? "";

	if (!rel || !sha) return NextResponse.json({ error: "Invalid params" }, { status: 400 });
	// Reject anything that is not a valid abbreviated or full SHA
	if (!/^[0-9a-f]{7,40}$/i.test(sha))
		return NextResponse.json({ error: "Invalid sha" }, { status: 400 });

	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const repo = await findEnclosingGitRepo(rootDir, resolved.relPath);
	if (!repo)
		return NextResponse.json({ error: "Not in a git repository" }, { status: 404 });

	try {
		const diff = await gitFileDiff(repo.repoDir, repo.relFromRepo, sha);
		return NextResponse.json({ diff });
	} catch {
		return NextResponse.json({ error: "Diff failed" }, { status: 500 });
	}
}
