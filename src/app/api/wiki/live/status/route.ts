import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import {
	latestOpenSession,
	latestRequest,
	isAttached,
	hasActiveRequest,
} from "@/lib/proof/live/store";
import { lookupAgentById } from "@/lib/proof/registry";

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
	const attached = isAttached(session) || (session ? hasActiveRequest(session.id) : false);
	const lastRequest = session ? latestRequest(session.id) : null;

	// Resolve a human-readable name for the attached agent so the UI can say
	// exactly who a request would go to.
	let agentName: string | null = null;
	if (attached && session?.agentId) {
		const agent = await lookupAgentById(session.agentId);
		agentName = agent?.displayName ?? session.agentId;
	}

	return NextResponse.json({
		attached,
		session: session
			? { id: session.id, agentId: session.agentId, agentName, state: session.state }
			: null,
		lastRequest: lastRequest
			? {
					id: lastRequest.id,
					kind: lastRequest.kind,
					state: lastRequest.state,
					outcome: lastRequest.outcome,
					path: lastRequest.path,
					blockRef: lastRequest.blockRef,
					runId: lastRequest.runId,
					itemCount: lastRequest.items?.length ?? null,
				}
			: null,
	});
}
