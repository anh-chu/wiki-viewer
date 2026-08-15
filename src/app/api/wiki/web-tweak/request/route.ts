import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { randomBytes } from "node:crypto";
import { getOrCreateSession, enqueueRequest } from "@/lib/proof/live/store";
import type { LiveInstructionItem } from "@/lib/proof/live/store";
import {
	createPreview,
	createBatchPreview,
	createVariantsPreview,
	linkRequest,
	type WebInstructionItem,
} from "@/lib/web-tweak/preview-store";

export const runtime = "nodejs";

interface BatchItemInput {
	instructionId?: string;
	selector?: string;
	tag?: string;
	snippet?: string;
	text?: string;
	instruction?: string;
}

interface Body {
	path?: string;
	selector?: string;
	tag?: string;
	snippet?: string;
	text?: string;
	note?: string | null;
	/** Batch dispatch: N pinned instructions sent as one run. */
	items?: BatchItemInput[];
	/** Variants: ask the agent for N candidate options for this one target. */
	variants?: boolean;
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
	if (!rel) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "path required" },
			{ status: 400 },
		);
	}

	// Batch path: N instructions dispatched as one run.
	if (Array.isArray(body.items)) {
		return handleBatch(request, ws, rel, body.items);
	}

	// Variants path: one target, N candidate options.
	if (body.variants === true) {
		return handleVariants(request, ws, rel, body);
	}

	const selector = str(body.selector, 2000);
	const tag = str(body.tag, 64) ?? "";
	const snippet = str(body.snippet, 4000) ?? "";
	const text = str(body.text, 2000) ?? "";
	const note = str(body.note, 4000);

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
		previewId: preview.id,
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

/**
 * Variants dispatch: one target, one instruction, N candidate options requested
 * in a single web.tweak.variants run. Creates a variants preview transaction and
 * enqueues the request; the agent replies with variants[] in one shot.
 */
async function handleVariants(
	_request: Request,
	ws: { id: string },
	rel: string,
	body: Body,
): Promise<NextResponse> {
	const selector = str(body.selector, 2000);
	const tag = str(body.tag, 64) ?? "";
	const snippet = str(body.snippet, 4000) ?? "";
	const text = str(body.text, 2000) ?? "";
	const note = str(body.note, 4000);
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
	const preview = createVariantsPreview({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		selector,
		tag,
		snippet,
		text,
		note,
	});

	const enq = enqueueRequest({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		blockRef: null,
		baseRevision: null,
		kind: "web.tweak.variants",
		instruction: note,
		previewId: preview.id,
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
		variants: true,
	});
}

/**
 * Batch dispatch: N instructions pinned to elements sent as ONE run. Creates a
 * single batch preview transaction + one live request carrying the items[] and
 * a generated runId. Same one-outstanding-per-session invariant applies.
 */
async function handleBatch(
	_request: Request,
	ws: { id: string },
	rel: string,
	rawItems: BatchItemInput[],
): Promise<NextResponse> {
	if (rawItems.length === 0) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "items must be non-empty" },
			{ status: 400 },
		);
	}
	const items: WebInstructionItem[] = [];
	for (const raw of rawItems) {
		const selector = str(raw.selector, 2000);
		const instruction = str(raw.instruction, 4000);
		if (!selector) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "each item needs a selector" },
				{ status: 400 },
			);
		}
		if (!instruction || instruction.trim().length === 0) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "each item needs an instruction" },
				{ status: 400 },
			);
		}
		items.push({
			instructionId: str(raw.instructionId, 64) ?? randomBytes(6).toString("hex"),
			selector,
			tag: str(raw.tag, 64) ?? "",
			snippet: str(raw.snippet, 4000) ?? "",
			text: str(raw.text, 2000) ?? "",
			instruction,
		});
	}

	const runId = `run:${randomBytes(4).toString("hex")}`;
	const session = getOrCreateSession(ws.id);

	const preview = createBatchPreview({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		runId,
		items,
	});

	const liveItems: LiveInstructionItem[] = items.map((it) => ({
		instructionId: it.instructionId,
		blockRef: it.selector,
		baseRevision: null,
		instruction: it.instruction,
		selectionText: JSON.stringify({
			selector: it.selector,
			tag: it.tag,
			snippet: it.snippet,
		}),
	}));

	const enq = enqueueRequest({
		sessionId: session.id,
		workspaceId: ws.id,
		path: rel,
		blockRef: null,
		baseRevision: null,
		kind: "web.tweak",
		instruction: null,
		previewId: preview.id,
		// Carry the previewId so the agent can correlate its batch reply.
		selectionText: JSON.stringify({ previewId: preview.id }),
		selectionStart: null,
		selectionEnd: null,
		items: liveItems,
		runId,
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
		runId,
		requestId: enq.request.id,
		sessionId: session.id,
		seq: enq.request.seq,
	});
}
