import { exec } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	// Path traversal guard
	const resolved = safeWorkspacePath(rootDir, rel);
	if (!resolved)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	// Open in system file manager
	const platform = process.platform;
	const cmd =
		platform === "darwin"
			? `open -R "${resolved}"`
			: platform === "win32"
				? `explorer /select,"${resolved}"`
				: `xdg-open "${path.dirname(resolved)}"`;

	exec(cmd, () => {});
	return NextResponse.json({ ok: true });
}
