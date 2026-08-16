import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { readSnapshot } from "@/lib/proof/ops-applier";
import { createProposal, bindRequest, deleteProposal } from "@/lib/proof/live/md-proposal-store";
import { createHash, randomBytes } from "node:crypto";
import {
	getOrCreateSession,
	enqueueRequest,
	getRequest,
	markState,
	type LiveInstructionItem,
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
	// Batch "Send to agent": N instruction items dispatched as one run.
	items?: unknown;
}

/** Validate + coerce untrusted batch items; returns null if any item is malformed. */
function parseItems(raw: unknown): LiveInstructionItem[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: LiveInstructionItem[] = [];
	for (const it of raw) {
		if (typeof it !== "object" || it === null) return null;
		const o = it as Record<string, unknown>;
		if (typeof o.instruction !== "string" || o.instruction.trim().length === 0)
			return null;
		if (typeof o.instructionId !== "string" || o.instructionId.length === 0)
			return null;
		if (o.blockRef != null && typeof o.blockRef !== "string") return null;
		if (o.baseRevision != null && typeof o.baseRevision !== "number") return null;
		out.push({
			instructionId: o.instructionId,
			blockRef: (o.blockRef as string | undefined) ?? null,
			baseRevision: (o.baseRevision as number | undefined) ?? null,
			instruction: o.instruction,
			selectionText:
				typeof o.selectionText === "string" ? o.selectionText : null,
		});
	}
	return out;
}

/**
 * POST /api/wiki/live/request — human dispatches intent to the attached agent.
 *
 * generate/steer: carry a freeform instruction (and, for generate, the selected
 * block + revision) to the waiting agent. accept/discard: notify the session that
 * a live proposal was resolved by the human through the editor UI.
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
	const hasBatch = kind === "generate" && body.items !== undefined;
	if (kind === "generate" || kind === "steer") {
		// A batch run carries per-item instructions instead of a top-level one.
		if (
			!hasBatch &&
			(typeof instruction !== "string" || instruction.trim().length === 0)
		) {
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

	// Batch run: one dispatch carrying N instruction items. Only on generate.
	const items = kind === "generate" ? parseItems(body.items) : null;
	if (kind === "generate" && body.items !== undefined && items === null) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "items must be a non-empty array of instructions" },
			{ status: 400 },
		);
	}
	const runId = items ? `run_${randomBytes(6).toString("hex")}` : null;

	// md-surface items carry a string blockRef + numeric baseRevision. Each gets
	// its own md proposal (server-computed baseBlockHash) so per-item accept /
	// discard flows through the unchanged md-resolve route keyed by previewId.
	// Web-tweak batch items carry baseRevision:null so they never enter this path.
	const mdItems = items
		? items.filter(
				(i) => typeof i.blockRef === "string" && typeof i.baseRevision === "number",
			)
		: [];
	const trackedPreviewIds: string[] = [];
	if (mdItems.length > 0) {
		const rp = await resolveWorkspacePath(ws.rootDir, rel, { allowMissing: true });
		if (!rp) {
			return NextResponse.json({ error: "INVALID_PATH" }, { status: 400 });
		}
		const snapshot = await readSnapshot(ws.rootDir, rp.relPath);
		// No live-md snapshot for this doc: it is not a markdown-surface target
		// (e.g. legacy/web batch). Leave items untouched so behavior stays
		// byte-identical. BLOCK_NOT_FOUND is reserved for a real md doc with a
		// stale/bad ref (snapshot present but block absent).
		if (snapshot) for (const item of mdItems) {
			const block = snapshot?.blocks.find((b) => b.ref === item.blockRef);
			if (!block) {
				return NextResponse.json({ error: "BLOCK_NOT_FOUND" }, { status: 400 });
			}
			const baseBlockHash = `sha256:${createHash("sha256").update(block.markdown, "utf8").digest("hex")}`;
			const proposal = createProposal({
				workspaceId: ws.id,
				path: rp.relPath,
				blockRef: item.blockRef as string,
				baseRevision: item.baseRevision as number,
				baseBlockHash,
			});
			item.baseBlockHash = baseBlockHash;
			item.previewId = proposal.previewId;
			trackedPreviewIds.push(proposal.previewId);
		}
	}

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
		items,
		runId,
	});
	if (!enq.ok) {
		// Enqueue conflicted: unbind orphan proposals created in this dispatch so
		// they don't linger forever in state 'requested'. deleteProposal only removes
		// rows still 'requested' with no request_id, so it is safe.
		for (const previewId of trackedPreviewIds) {
			deleteProposal(previewId);
		}
		return NextResponse.json(
			{
				error: enq.code,
				message: "A live request is already outstanding for this session.",
				outstandingRequestId: enq.request.id,
			},
			{ status: 409 },
		);
	}

	for (const previewId of trackedPreviewIds) {
		bindRequest(previewId, enq.request.id);
	}

	const mdItemPreviews =
		mdItems.length > 0
			? mdItems.map((i) => ({
					instructionId: i.instructionId,
					previewId: i.previewId ?? null,
				}))
			: undefined;

	return NextResponse.json({
		ok: true,
		requestId: enq.request.id,
		sessionId: session.id,
		seq: enq.request.seq,
		runId: enq.request.runId,
		...(mdItemPreviews ? { items: mdItemPreviews } : {}),
	});
}
