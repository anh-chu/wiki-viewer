import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { getScripts, getStatus, startApp, stopApp } from "@/lib/app-runner";

function canLaunchApp(ctx: { isAdmin: boolean }): boolean {
	// WIKI_NO_AUTH=1 keeps local single-user behavior.
	// WIKI_ALLOW_APP_RUNNER=1 is an explicit operator opt-in for non-admin launch.
	return (
		process.env.WIKI_NO_AUTH === "1" ||
		process.env.WIKI_ALLOW_APP_RUNNER === "1" ||
		ctx.isAdmin
	);
}

// GET /api/wiki/app?path=relative/path
export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	const status = getStatus(ctx.ws.id, rel);
	const abs = safeWorkspacePath(ctx.rootDir, rel);
	const scripts = abs ? getScripts(abs) : { scripts: [], defaultScript: null };
	return NextResponse.json({ ...status, ...scripts });
}

// POST /api/wiki/app  { path: "relative/path" }
export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	if (!canLaunchApp(ctx)) {
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
	}

	const body: { path?: string; script?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Missing path" }, { status: 400 });

	const abs = safeWorkspacePath(rootDir, rel);
	if (!abs)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const script = typeof body.script === "string" ? body.script : undefined;

	try {
		const result = await startApp(ctx.ws.id, rel, abs, script);
		return NextResponse.json(result);
	} catch (e) {
		return NextResponse.json({ error: String(e) }, { status: 500 });
	}
}

// DELETE /api/wiki/app  { path: "relative/path" }
export async function DELETE(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	if (!canLaunchApp(ctx)) {
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
	}

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Missing path" }, { status: 400 });

	stopApp(ctx.ws.id, rel);
	return NextResponse.json({ ok: true });
}
