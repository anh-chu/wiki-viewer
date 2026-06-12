import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;

	if (!rel || typeof rel !== "string" || /[<>:"|?*]/.test(rel)) {
		return NextResponse.json({ error: "Invalid folder path" }, { status: 400 });
	}

	const folderPath = safeWorkspacePath(rootDir, rel);
	if (!folderPath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		await mkdir(folderPath, { recursive: true });
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json(
			{ error: "Failed to create folder" },
			{ status: 500 },
		);
	}
}
