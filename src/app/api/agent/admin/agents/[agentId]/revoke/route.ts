/**
 * POST /api/agent/admin/agents/:agentId/revoke
 *
 * Revoke (remove) a registered agent. Requires authenticated user session.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { readRegistry, removeAgent } from "@/lib/proof/registry";

export const runtime = "nodejs";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ agentId: string }> },
): Promise<NextResponse> {
	const owner = await requireUser(req);
	if (!owner.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const { agentId } = await params;

	// Check ownership before removal. Legacy agents (no ownerUserId) are
	// revocable by any authenticated user.
	const registry = await readRegistry();
	const agent = (registry?.agents ?? []).find((a) => a.id === agentId);
	if (!agent) {
		return NextResponse.json({ error: "NOT_FOUND", message: "Agent not found" }, { status: 404 });
	}
	if (agent.ownerUserId !== undefined && agent.ownerUserId !== owner.user.id) {
		return NextResponse.json({ error: "FORBIDDEN", message: "You do not own this agent" }, { status: 403 });
	}

	const removed = await removeAgent(agentId);
	if (!removed) {
		return NextResponse.json({ error: "NOT_FOUND", message: "Agent not found" }, { status: 404 });
	}

	return NextResponse.json({ ok: true });
}
