import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { getStatus, startApp, stopApp } from "@/lib/app-runner";

// GET /api/wiki/app?path=relative/path
export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	return NextResponse.json(getStatus(rel));
}

// POST /api/wiki/app  { path: "relative/path" }
export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Missing path" }, { status: 400 });

	const abs = safeWorkspacePath(rootDir, rel);
	if (!abs)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		const result = await startApp(rel, abs);
		return NextResponse.json(result);
	} catch (e) {
		return NextResponse.json({ error: String(e) }, { status: 500 });
	}
}

// DELETE /api/wiki/app  { path: "relative/path" }
export async function DELETE(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Missing path" }, { status: 400 });

	stopApp(rel);
	return NextResponse.json({ ok: true });
}
