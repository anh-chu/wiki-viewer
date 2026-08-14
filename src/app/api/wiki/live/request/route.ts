import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import {
	getOrCreateSession,
	enqueueRequest,
	getRequest,
	markState,
	type RequestKind,
	type RequestOutcome,
} from "@/lib/proof/live/store";

export const runtime = "nodejs";

const KINDS: RequestKind[] = ["generate", "steer", "accept", "discard", "exit"];

interface Body {
	path?: string;
	blockRef?: string | null;
	baseRevision?: number | null;
	kind?: RequestKind;
	instruction?: string | null;
	// Optional precise-pointing context (all nullable, additive).
	selectionText?: string | null;
	selectionStart?: number | null;
	selectionEnd?: number | null;
	// For accept/discard notifications: the request being resolved.
	requestId?: string;
	outcome?: RequestOutcome;
}

/**
 * POST /api/wiki/live/request — human dispatches intent to the attached agent.
 *
 * generate/steer: carry a freeform instruction (and, for generate, the selected
 * block + revision) to the waiting agent. accept/discard: notify the session that
 * a proof-span was resolved by the human through the normal editor UI.
 */
export async function POST(request: Request): Promise<NextResponse> {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}
	const { ws } = ctx;

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
	}

	const { path: rel, blockRef, baseRevision, kind, instruction } = body;
	// Precise-pointing context is untrusted human input: coerce and store only.
	// Never used for path/scope/revision logic.
	const selectionText =
		typeof body.selectionText === "string" ? body.selectionText : null;
	const selectionStart =
		typeof body.selectionStart === "number" && Number.isFinite(body.selectionStart)
			? body.selectionStart
			: null;
	const selectionEnd =
		typeof body.selectionEnd === "number" && Number.isFinite(body.selectionEnd)
			? body.selectionEnd
			: null;
	if (!kind || !KINDS.includes(kind)) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: `kind must be one of ${KINDS.join(", ")}` },
			{ status: 400 },
		);
	}
	if (!rel || typeof rel !== "string") {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "path required" },
			{ status: 400 },
		);
	}
	if (kind === "generate" || kind === "steer") {
		if (typeof instruction !== "string" || instruction.trim().length === 0) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "instruction required for generate/steer" },
				{ status: 400 },
			);
		}
		if (blockRef != null && typeof blockRef !== "string") {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "blockRef must be a string" },
				{ status: 400 },
			);
		}
		if (baseRevision != null && typeof baseRevision !== "number") {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "baseRevision must be a number" },
				{ status: 400 },
			);
		}
	}

	// accept/discard: resolve the referenced live request as a notification.
	// Only resolve a request that belongs to THIS workspace — never let a user in
	// one workspace mutate another workspace's request lifecycle by guessing an id.
	if (kind === "accept" || kind === "discard") {
		if (body.requestId) {
			const existing = getRequest(body.requestId);
			if (!existing || existing.workspaceId !== ws.id) {
				return NextResponse.json(
					{ error: "REQUEST_NOT_FOUND" },
					{ status: 404 },
				);
			}
			markState(
				body.requestId,
				"resolved",
				kind === "accept" ? "accepted" : "reverted",
			);
		}
		return NextResponse.json({ ok: true, resolved: body.requestId ?? null });
	}

	// generate/steer need an open session. Create one (agent-less) if the agent
	// has not attached yet; the request waits until an agent attaches and polls.
	const session = getOrCreateSession(ws.id);

	const enq = enqueueRequest({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		blockRef: blockRef ?? null,
		baseRevision: baseRevision ?? null,
		kind,
		instruction: instruction ?? null,
		selectionText,
		selectionStart,
		selectionEnd,
	});
	if (!enq.ok) {
		return NextResponse.json(
			{
				error: enq.code,
				message: "A live request is already outstanding for this session.",
				outstandingRequestId: enq.request.id,
			},
			{ status: 409 },
		);
	}

	return NextResponse.json({
		ok: true,
		requestId: enq.request.id,
		sessionId: session.id,
		seq: enq.request.seq,
	});
}
