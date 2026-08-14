import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { getRequest, markState } from "@/lib/proof/live/store";
import {
	getPreview,
	attachPreview,
	type BaseFile,
	type CandidateSourcePatch,
} from "@/lib/web-tweak/preview-store";
import type { DomOp } from "@/lib/web-tweak/protocol";

export const runtime = "nodejs";

interface Body {
	previewId?: string;
	requestId?: string;
	domPreviewOps?: DomOp[] | null;
	candidateSourcePatch?: CandidateSourcePatch | null;
	baseFiles?: BaseFile[];
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

/** Validate DOM ops are data-only and well-typed. Reject anything unexpected. */
function validOps(ops: unknown): ops is DomOp[] {
	if (!Array.isArray(ops)) return false;
	return ops.every((o) => {
		if (!o || typeof o !== "object") return false;
		const op = o as Record<string, unknown>;
		return typeof op.type === "string" && OP_TYPES.has(op.type);
	});
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

	// Agent reports failure to produce a preview.
	if (body.status === "error") {
		if (requestId) {
			const lr = getRequest(requestId);
			if (lr && lr.workspaceId === ws.id) markState(requestId, "error");
		}
		return NextResponse.json({ ok: true, status: "error" });
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
	// A committable candidate must declare the base files it was derived against.
	if (candidate && baseFiles.length === 0) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "candidateSourcePatch requires baseFiles" },
			{ status: 400 },
		);
	}

	const attached = attachPreview(previewId, {
		domPreviewOps: ops,
		candidateSourcePatch: candidate,
		baseFiles,
	});
	if (!attached) {
		return NextResponse.json(
			{ error: "INVALID_STATE", message: `preview is ${preview.status}` },
			{ status: 409 },
		);
	}

	// The live request moves to resolved (the agent's turn is done); the human now
	// reviews the preview and accepts/discards.
	if (requestId) {
		const lr = getRequest(requestId);
		if (lr && lr.workspaceId === ws.id) markState(requestId, "resolved");
	}

	return NextResponse.json({ ok: true, status: "preview-ready", previewId });
}
