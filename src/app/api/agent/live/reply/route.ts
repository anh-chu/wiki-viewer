import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { getRequest, getSession, markState } from "@/lib/proof/live/store";

export const runtime = "nodejs";

type ReplyStatus = "working" | "done" | "error" | "stale";

/**
 * POST /api/agent/live/reply
 * Body: { requestId, status: "working" | "done" | "error" | "stale" }
 *
 * The agent reports progress on a delivered generate/steer request. The actual
 * document edit lands separately through POST /api/agent/files/<path>; this only
 * updates the live request lifecycle.
 */
export async function POST(req: Request): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}
	const wsx = await resolveWorkspaceForAgent(req);
	if (!wsx.ok) {
		return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	}
	const { ws } = wsx;

	const scope = enforceScope(auth.agent, {
		filePath: "",
		op: "mutate",
		workspaceId: ws.id,
	});
	if (!scope.ok) {
		return NextResponse.json(
			{ error: scope.code, message: scope.message },
			{ status: 403 },
		);
	}

	let body: { requestId?: string; status?: ReplyStatus };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
	}

	const { requestId, status } = body;
	if (!requestId || !status) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "requestId and status required" },
			{ status: 400 },
		);
	}
	const valid: ReplyStatus[] = ["working", "done", "error", "stale"];
	if (!valid.includes(status)) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: `status must be one of ${valid.join(", ")}` },
			{ status: 400 },
		);
	}

	const request = getRequest(requestId);
	if (!request || request.workspaceId !== ws.id) {
		return NextResponse.json({ error: "REQUEST_NOT_FOUND" }, { status: 404 });
	}
	const session = getSession(request.sessionId);
	if (!session || session.agentId !== auth.agent.id) {
		return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
	}

	// Map agent status to request state. "done" leaves the turn awaiting the
	// human's accept/revert, so it is not terminal here; the human resolves it.
	if (status === "working") {
		markState(requestId, "working");
	} else if (status === "done") {
		markState(requestId, "working");
	} else if (status === "error") {
		markState(requestId, "error");
	} else if (status === "stale") {
		markState(requestId, "stale");
	}

	return NextResponse.json({ ok: true, requestId, state: getRequest(requestId)!.state });
}
