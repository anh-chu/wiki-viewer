import { exec } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

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
	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	// Open in system file manager
	const platform = process.platform;
	const cmd =
		platform === "darwin"
			? `open -R "${resolved.absolutePath}"`
			: platform === "win32"
				? `explorer /select,"${resolved.absolutePath}"`
				: `xdg-open "${path.dirname(resolved.absolutePath)}"`;

	exec(cmd, () => {});
	return NextResponse.json({ ok: true });
}
