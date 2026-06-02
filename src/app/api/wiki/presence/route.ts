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
import { requireUser } from "@/lib/auth/server";
import { setLease, clearLease } from "@/lib/proof/lease";
import { safeRootPath } from "@/lib/root-dir";

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
	const auth = await requireUser(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", "Not authenticated", 401);

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
	if (!safeRootPath(relPath)) {
		return errJson("INVALID_PATH", "Path traversal rejected", 400);
	}

	if (action === "open" || action === "heartbeat") {
		setLease(relPath, auth.user.id);
	} else {
		// close
		clearLease(relPath, auth.user.id);
	}

	return NextResponse.json({ ok: true });
}
