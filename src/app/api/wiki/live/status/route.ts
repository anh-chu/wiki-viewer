import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import {
	latestOpenSession,
	latestRequest,
	isAttached,
} from "@/lib/proof/live/store";

export const runtime = "nodejs";

/**
 * GET /api/wiki/live/status — editor asks whether an agent is on the line and
 * what the current turn looks like.
 */
export async function GET(request: Request): Promise<NextResponse> {
	const ctx = await resolveWorkspaceForUser(request, "read");
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}
	const { ws } = ctx;

	const session = latestOpenSession(ws.id);
	const attached = isAttached(session);
	const lastRequest = session ? latestRequest(session.id) : null;

	return NextResponse.json({
		attached,
		session: session
			? { id: session.id, agentId: session.agentId, state: session.state }
			: null,
		lastRequest: lastRequest
			? {
					id: lastRequest.id,
					kind: lastRequest.kind,
					state: lastRequest.state,
					outcome: lastRequest.outcome,
					path: lastRequest.path,
					blockRef: lastRequest.blockRef,
				}
			: null,
	});
}
