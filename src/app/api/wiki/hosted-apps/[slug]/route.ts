/**
 * Hosted Apps runtime control for a single node entry.
 *
 *   POST /api/wiki/hosted-apps/<slug>  { action: "start" | "stop" }
 *
 * Only `node` entries have a process to control. Starting/stopping runs the CSRF
 * origin check and the app-runner authorization gate, and enforces access to the
 * entry's owning workspace. The child port is chosen fresh by the runner on
 * every start; nothing here bakes a port in.
 */
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { startApp, stopApp } from "@/lib/app-runner";
import { getBySlug } from "@/lib/hosted-apps";
import { isAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/server";
import { getWorkspace, safeWorkspacePath, userCanAccess } from "@/lib/workspaces";

function canLaunchApp(isAdminUser: boolean): boolean {
	return (
		process.env.WIKI_NO_AUTH === "1" ||
		process.env.WIKI_ALLOW_APP_RUNNER === "1" ||
		isAdminUser
	);
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ slug: string }> },
) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	// The slug route resolves its own workspace from the entry (not ?ws=), so we
	// authenticate directly and check access against the entry's workspace.
	let userId = "local";
	let admin = true;
	if (process.env.WIKI_NO_AUTH !== "1") {
		const auth = await requireUser(request);
		if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
		userId = auth.user.id;
		admin = await isAdmin(auth.user.id, auth.user.email);
	}

	if (!canLaunchApp(admin)) {
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
	}

	const { slug } = await params;
	const entry = await getBySlug(slug);
	if (!entry) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
	if (entry.type !== "node") {
		return NextResponse.json({ error: "NOT_A_NODE_APP" }, { status: 400 });
	}

	const ws = await getWorkspace(entry.workspaceId);
	if (!ws) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });
	if (process.env.WIKI_NO_AUTH !== "1" && !userCanAccess(ws, userId, admin)) {
		return NextResponse.json({ error: "WORKSPACE_FORBIDDEN" }, { status: 403 });
	}

	const body: { action?: string } = await request.json().catch(() => ({}));
	const action = body.action;

	if (action === "stop") {
		stopApp(entry.workspaceId, entry.relPath);
		return NextResponse.json({ ok: true, status: "stopped" });
	}

	if (action === "start") {
		const abs = safeWorkspacePath(ws.rootDir, entry.relPath);
		if (!abs || !existsSync(abs)) {
			return NextResponse.json({ error: "MISSING_DIR" }, { status: 409 });
		}
		try {
			const result = await startApp(entry.workspaceId, entry.relPath, abs, entry.script);
			return NextResponse.json({ ok: true, status: "starting", port: result.port });
		} catch (e) {
			return NextResponse.json({ error: String(e) }, { status: 500 });
		}
	}

	return NextResponse.json({ error: "INVALID_ACTION" }, { status: 400 });
}
