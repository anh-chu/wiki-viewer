/**
 * POST /api/wiki/presence
 *
 * Human editor heartbeat — sets or clears a human-edit lease so that
 * computeCollabState can return "active" even before the first suggestion.
 *
 * Body: { path: string; action: "open" | "heartbeat" | "close" }
 *
 * Authenticated: requires a logged-in browser session (same as /api/wiki/watch).
 * Agent tokens are NOT accepted here — this endpoint is human-only.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { setLease, clearLease } from "@/lib/proof/lease";

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
	const ctx = await resolveWorkspaceForUser(req);
	if (!ctx.ok) return errJson(ctx.code, "Not authenticated", ctx.status);
	const { rootDir } = ctx;

	let body: { path?: unknown; action?: unknown };
	try {
		body = (await req.json()) as { path?: unknown; action?: unknown };
	} catch {
		return errJson("INVALID_PAYLOAD", "Request body must be JSON", 400);
	}

	const relPath = typeof body.path === "string" ? body.path : null;
	const action = typeof body.action === "string" ? body.action : null;

	if (!relPath) return errJson("MISSING_PATH", "path is required", 400);
	if (!action || !["open", "heartbeat", "close"].includes(action)) {
		return errJson("INVALID_ACTION", "action must be open | heartbeat | close", 400);
	}

	// Basic traversal guard
	if (!safeWorkspacePath(rootDir, relPath)) {
		return errJson("INVALID_PATH", "Path traversal rejected", 400);
	}

	if (action === "open" || action === "heartbeat") {
		setLease(rootDir, relPath, ctx.userId);
	} else {
		// close
		clearLease(rootDir, relPath, ctx.userId);
	}

	return NextResponse.json({ ok: true });
}
