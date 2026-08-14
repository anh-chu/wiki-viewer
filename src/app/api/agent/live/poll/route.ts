import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import {
	getSession,
	touchAgent,
	nextDeliverableRequest,
	markDelivered,
} from "@/lib/proof/live/store";

export const runtime = "nodejs";

/** Max time to hold the poll open before returning a timeout event (ms). */
const HOLD_MS = 25_000;
/** How often to check for a new pending request while holding (ms). */
const TICK_MS = 400;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET /api/agent/live/poll?sessionId=&afterSeq=
 *
 * Long-poll. Held open up to HOLD_MS; the held request itself is the agent's
 * presence signal (touchAgent each tick). Returns the next pending request for
 * the session as soon as one appears, or { type: "timeout" } on expiry.
 */
export async function GET(req: Request): Promise<NextResponse> {
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

	const { searchParams } = new URL(req.url);
	const sessionId = searchParams.get("sessionId");
	const afterSeqRaw = searchParams.get("afterSeq");
	const afterSeq = afterSeqRaw !== null ? parseInt(afterSeqRaw, 10) : 0;
	// Optional shorter hold (still capped at HOLD_MS); lets a caller do a quick cycle.
	const holdRaw = searchParams.get("holdMs");
	const holdMs =
		holdRaw !== null && !Number.isNaN(parseInt(holdRaw, 10))
			? Math.min(Math.max(parseInt(holdRaw, 10), 0), HOLD_MS)
			: HOLD_MS;

	if (!sessionId) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "sessionId required" },
			{ status: 400 },
		);
	}
	if (Number.isNaN(afterSeq) || afterSeq < 0) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "afterSeq must be a non-negative integer" },
			{ status: 400 },
		);
	}

	const session = getSession(sessionId);
	// Session must exist, be open, belong to this workspace, and be owned by
	// this agent — never leak another workspace's or agent's requests.
	if (
		!session ||
		session.state !== "open" ||
		session.workspaceId !== ws.id ||
		session.agentId !== auth.agent.id
	) {
		return NextResponse.json(
			{ error: "SESSION_NOT_FOUND" },
			{ status: 404 },
		);
	}

	const deadline = Date.now() + holdMs;
	// Signal aborted by client disconnect.
	const signal = req.signal;
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			return NextResponse.json({ type: "aborted" });
		}
		touchAgent(sessionId);
		const pending = nextDeliverableRequest(sessionId, afterSeq);
		if (pending) {
			markDelivered(pending.id);
			return NextResponse.json({
				type: pending.kind,
				request: {
					requestId: pending.id,
					sessionId: pending.sessionId,
					path: pending.path,
					blockRef: pending.blockRef,
					baseRevision: pending.baseRevision,
					kind: pending.kind,
					instruction: pending.instruction,
					selectionText: pending.selectionText,
					selectionStart: pending.selectionStart,
					selectionEnd: pending.selectionEnd,
					items: pending.items,
					runId: pending.runId,
					seq: pending.seq,
					idempotencyKey: `live:${pending.id}`,
					inResponseTo: `live:${pending.id}`,
				},
			});
		}
		await sleep(TICK_MS);
	}
	return NextResponse.json({ type: "timeout" });
}
