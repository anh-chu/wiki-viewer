import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { detectGitRepo, pullRepo, currentBranch, headSha } from "@/lib/git";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved || resolved.absolutePath === rootDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	const repoDir = resolved.absolutePath;

	// Verify it's a valid git repo root (same check as directory listing)
	if (!(await detectGitRepo(repoDir))) {
		return NextResponse.json(
			{ error: "Not a git repository" },
			{ status: 400 },
		);
	}

	try {
		await pullRepo({ rootDir: repoDir });
		const [branch, sha] = await Promise.all([
			currentBranch(repoDir),
			headSha(repoDir),
		]);
		return NextResponse.json({ ok: true, branch, sha });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Pull failed";
		return NextResponse.json(
			{ error: "Pull failed", message },
			{ status: 500 },
		);
	}
}
