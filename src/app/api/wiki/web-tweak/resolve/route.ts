import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getPreview, resolvePreview } from "@/lib/web-tweak/preview-store";
import { commitCandidate } from "@/lib/web-tweak/accept";

export const runtime = "nodejs";

interface Body {
	previewId?: string;
	action?: "accept" | "discard";
}

/**
 * POST /api/wiki/web-tweak/resolve — human accepts or discards a preview.
 *
 * Accept commits the transaction's candidate source patch VERBATIM, iff every
 * base file hash still matches on disk; otherwise the transaction is invalidated
 * and nothing is written. Accept/discard are driven ONLY by this trusted user
 * endpoint, never by an iframe message.
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

	const { previewId, action } = body;
	if (!previewId || (action !== "accept" && action !== "discard")) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "previewId and action (accept|discard) required" },
			{ status: 400 },
		);
	}

	// Workspace isolation: only resolve a preview that belongs to this workspace.
	const preview = getPreview(previewId);
	if (!preview || preview.workspaceId !== ws.id) {
		return NextResponse.json({ error: "PREVIEW_NOT_FOUND" }, { status: 404 });
	}
	if (preview.status !== "preview-ready") {
		return NextResponse.json(
			{ error: "INVALID_STATE", message: `preview is ${preview.status}` },
			{ status: 409 },
		);
	}

	if (action === "discard") {
		resolvePreview(previewId, "discarded");
		return NextResponse.json({ ok: true, status: "discarded" });
	}

	// Accept: verify base hashes, then write the candidate verbatim.
	const result = await commitCandidate(
		ws.rootDir,
		preview.baseFiles,
		preview.candidateSourcePatch,
	);
	if (!result.ok) {
		if (result.code === "BASE_DRIFT") {
			resolvePreview(previewId, "invalidated");
			return NextResponse.json(
				{ error: "BASE_DRIFT", message: "Source changed since preview; re-tweak.", detail: result.detail },
				{ status: 409 },
			);
		}
		if (result.code === "NO_CANDIDATE") {
			return NextResponse.json(
				{ error: "NO_CANDIDATE", message: "This preview is visual only and cannot be accepted." },
				{ status: 422 },
			);
		}
		return NextResponse.json(
			{ error: result.code, detail: result.detail },
			{ status: 400 },
		);
	}

	resolvePreview(previewId, "accepted");
	return NextResponse.json({ ok: true, status: "accepted", written: result.written.length });
}
