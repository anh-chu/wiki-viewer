import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getOrCreateSession, enqueueRequest } from "@/lib/proof/live/store";
import { createPreview, linkRequest } from "@/lib/web-tweak/preview-store";

export const runtime = "nodejs";

interface Body {
	path?: string;
	selector?: string;
	tag?: string;
	snippet?: string;
	text?: string;
	note?: string | null;
}

function str(v: unknown, max: number): string | null {
	return typeof v === "string" ? v.slice(0, max) : null;
}

/**
 * POST /api/wiki/web-tweak/request — human points at a rendered element in a web
 * preview and asks the attached agent to change it.
 *
 * Creates a preview transaction (status `requested`) keyed by previewId, then
 * enqueues a `web.tweak` live request so the waiting agent produces the DOM
 * preview ops + candidate source patch + base hashes for that previewId.
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

	const rel = str(body.path, 4096);
	const selector = str(body.selector, 2000);
	const tag = str(body.tag, 64) ?? "";
	const snippet = str(body.snippet, 4000) ?? "";
	const text = str(body.text, 2000) ?? "";
	const note = str(body.note, 4000);

	if (!rel) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "path required" },
			{ status: 400 },
		);
	}
	if (!selector) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "selector required" },
			{ status: 400 },
		);
	}
	if (!note || note.trim().length === 0) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "note required" },
			{ status: 400 },
		);
	}

	const session = getOrCreateSession(ws.id);

	const preview = createPreview({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		selector,
		tag,
		snippet,
		text,
		note,
	});

	// The agent receives the previewId + selection facts + note as the tweak
	// instruction. Reuse the live request channel (one outstanding per session).
	const enq = enqueueRequest({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		blockRef: null,
		baseRevision: null,
		kind: "web.tweak",
		instruction: note,
		// Carry the previewId + selector so the agent can correlate its reply.
		selectionText: JSON.stringify({ previewId: preview.id, selector, tag, snippet }),
		selectionStart: null,
		selectionEnd: null,
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
	linkRequest(preview.id, enq.request.id);

	return NextResponse.json({
		ok: true,
		previewId: preview.id,
		requestId: enq.request.id,
		sessionId: session.id,
		seq: enq.request.seq,
	});
}
