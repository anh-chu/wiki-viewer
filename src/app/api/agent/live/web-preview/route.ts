import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { markState } from "@/lib/proof/live/store";
import {
	getPreview,
	attachPreview,
	type BaseFile,
	type CandidateSourcePatch,
	type ItemPreview,
} from "@/lib/web-tweak/preview-store";
import type { DomOp } from "@/lib/web-tweak/protocol";

export const runtime = "nodejs";

interface Body {
	previewId?: string;
	requestId?: string;
	domPreviewOps?: DomOp[] | null;
	candidateSourcePatch?: CandidateSourcePatch | null;
	baseFiles?: BaseFile[];
	/** Batch: per-instruction preview ops (applied in-frame, keyed to instructionId). */
	itemPreviews?: ItemPreview[] | null;
	status?: "done" | "error";
}

const OP_TYPES = new Set([
	"setText",
	"setStyle",
	"setAttr",
	"removeAttr",
	"addClass",
	"removeClass",
]);

/** Validate DOM ops are data-only and well-typed, per union member. */
function validOp(op: Record<string, unknown>): boolean {
	const t = op.type;
	if (typeof t !== "string" || !OP_TYPES.has(t)) return false;
	switch (t) {
		case "setText":
			return typeof op.value === "string";
		case "setStyle":
			return typeof op.prop === "string" && typeof op.value === "string";
		case "setAttr":
			return typeof op.name === "string" && typeof op.value === "string";
		case "removeAttr":
			return typeof op.name === "string";
		case "addClass":
		case "removeClass":
			return typeof op.value === "string";
		default:
			return false;
	}
}

function validOps(ops: unknown): ops is DomOp[] {
	if (!Array.isArray(ops)) return false;
	return ops.every(
		(o) => !!o && typeof o === "object" && validOp(o as Record<string, unknown>),
	);
}

function validBaseFiles(v: unknown): v is BaseFile[] {
	return (
		Array.isArray(v) &&
		v.every(
			(f) =>
				f &&
				typeof f === "object" &&
				typeof (f as BaseFile).path === "string" &&
				typeof (f as BaseFile).sha256 === "string",
		)
	);
}

function validCandidate(v: unknown): v is CandidateSourcePatch {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	if (typeof c.summary !== "string") return false;
	if (!Array.isArray(c.files)) return false;
	return c.files.every(
		(f) =>
			f &&
			typeof f === "object" &&
			typeof (f as { path: unknown }).path === "string" &&
			typeof (f as { content: unknown }).content === "string",
	);
}

/**
 * POST /api/agent/live/web-preview — the attached agent submits its reply to a
 * `web.tweak` request: the DOM preview ops (applied in-frame) plus the immutable
 * candidate source patch and the base file hashes it was derived against.
 *
 * The candidate patch is stored, not applied; accept commits it later iff the
 * base hashes still match. A `candidateSourcePatch` of null is valid and means
 * "visual only, not acceptable".
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

	let body: Body;
	try {
		body = (await req.json()) as Body;
	} catch {
		return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
	}

	const { previewId, requestId } = body;
	if (!previewId) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "previewId required" },
			{ status: 400 },
		);
	}

	// Workspace isolation: the preview must belong to the agent's workspace.
	const preview = getPreview(previewId);
	if (!preview || preview.workspaceId !== ws.id) {
		return NextResponse.json({ error: "PREVIEW_NOT_FOUND" }, { status: 404 });
	}
	// Bind the reply to the exact live request that dispatched this preview, so a
	// malformed/hostile reply cannot attach to one preview while mutating another
	// request's lifecycle.
	if (!requestId || requestId !== preview.requestId) {
		return NextResponse.json(
			{ error: "REQUEST_MISMATCH", message: "requestId must match the preview's dispatched request" },
			{ status: 400 },
		);
	}

	// Agent reports failure to produce a preview. requestId is bound to this
	// workspace's preview above, so marking it is safe.
	if (body.status === "error") {
		markState(requestId, "error");
		return NextResponse.json({ ok: true, status: "error" });
	}

	const itemPreviews = body.itemPreviews ?? null;
	if (itemPreviews !== null) {
		const ok =
			Array.isArray(itemPreviews) &&
			itemPreviews.every(
				(ip) =>
					!!ip &&
					typeof ip === "object" &&
					typeof (ip as ItemPreview).instructionId === "string" &&
					validOps((ip as ItemPreview).ops),
			);
		if (!ok) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "itemPreviews must be {instructionId, ops[]}[]" },
				{ status: 400 },
			);
		}
		// Each itemPreview must correlate to an instruction the run actually
		// dispatched, and no instruction may be previewed twice. Prevents an agent
		// reply from mislabeling or fabricating item correlation.
		const known = new Set((preview.items ?? []).map((it) => it.instructionId));
		const seen = new Set<string>();
		for (const ip of itemPreviews as ItemPreview[]) {
			if (!known.has(ip.instructionId) || seen.has(ip.instructionId)) {
				return NextResponse.json(
					{
						error: "INVALID_PARAM",
						message: `itemPreviews instructionId must be a unique member of the run (bad: ${ip.instructionId})`,
					},
					{ status: 400 },
				);
			}
			seen.add(ip.instructionId);
		}
	}
	const ops = body.domPreviewOps ?? null;
	if (ops !== null && !validOps(ops)) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "domPreviewOps must be data-only DOM ops" },
			{ status: 400 },
		);
	}
	const candidate = body.candidateSourcePatch ?? null;
	if (candidate !== null && !validCandidate(candidate)) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "candidateSourcePatch malformed" },
			{ status: 400 },
		);
	}
	const baseFiles = body.baseFiles ?? [];
	if (!validBaseFiles(baseFiles)) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "baseFiles must be {path, sha256}[]" },
			{ status: 400 },
		);
	}
	// A committable candidate must declare a base hash for EVERY file it writes,
	// otherwise accept could write an unverified target while only checking an
	// unrelated base file. Extra base entries (dependencies) are allowed.
	if (candidate) {
		if (baseFiles.length === 0) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "candidateSourcePatch requires baseFiles" },
				{ status: 400 },
			);
		}
		// v1 commits are single-file so the "BASE_DRIFT => nothing written" invariant
		// holds without multi-file rollback/journaling. Multi-file needs a real
		// transaction; deferred.
		if (candidate.files.length !== 1) {
			return NextResponse.json(
				{ error: "INVALID_PARAM", message: "v1 candidateSourcePatch must edit exactly one file" },
				{ status: 400 },
			);
		}
		const baseset = new Set(baseFiles.map((b) => b.path));
		const uncovered = candidate.files.find((f) => !baseset.has(f.path));
		if (uncovered) {
			return NextResponse.json(
				{
					error: "INVALID_PARAM",
					message: `every candidate target needs a baseFiles hash (missing: ${uncovered.path})`,
				},
				{ status: 400 },
			);
		}
	}

	// Enforce the agent's path scope on every candidate + base file it proposes,
	// so a mutate-scoped agent cannot stage a write to a path outside its scope.
	if (candidate) {
		const paths = new Set<string>([
			...candidate.files.map((f) => f.path),
			...baseFiles.map((b) => b.path),
		]);
		for (const p of paths) {
			const s = enforceScope(auth.agent, {
				filePath: p,
				op: "mutate",
				workspaceId: ws.id,
			});
			if (!s.ok) {
				return NextResponse.json(
					{ error: s.code, message: s.message },
					{ status: 403 },
				);
			}
		}
	}

	const attached = attachPreview(previewId, {
		domPreviewOps: ops,
		candidateSourcePatch: candidate,
		baseFiles,
		itemPreviews,
	});
	if (!attached) {
		return NextResponse.json(
			{ error: "INVALID_STATE", message: `preview is ${preview.status}` },
			{ status: 409 },
		);
	}

	// The live request moves to resolved (the agent's turn is done); the human now
	// reviews the preview and accepts/discards.
	markState(requestId, "resolved");

	return NextResponse.json({ ok: true, status: "preview-ready", previewId });
}
