import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getPreview } from "@/lib/web-tweak/preview-store";

export const runtime = "nodejs";

/**
 * GET /api/wiki/web-tweak/status?previewId=... — the web preview UI polls a
 * preview transaction to learn when the agent's reply landed and to fetch the
 * DOM preview ops it should apply inside the iframe.
 *
 * Returns the transaction status, the domPreviewOps (to apply/revert in-frame),
 * whether a candidate source patch exists (accept is only offered when it does),
 * and a short patch summary for display. The candidate source content itself is
 * NOT returned to the browser; it is committed server-side on accept.
 */
export async function GET(request: Request): Promise<NextResponse> {
	const ctx = await resolveWorkspaceForUser(request, "read");
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}
	const { ws } = ctx;

	const url = new URL(request.url);
	const previewId = url.searchParams.get("previewId");
	if (!previewId) {
		return NextResponse.json(
			{ error: "INVALID_PARAM", message: "previewId required" },
			{ status: 400 },
		);
	}

	const preview = getPreview(previewId);
	if (!preview || preview.workspaceId !== ws.id) {
		return NextResponse.json({ error: "PREVIEW_NOT_FOUND" }, { status: 404 });
	}

	return NextResponse.json({
		ok: true,
		previewId: preview.id,
		status: preview.status,
		selector: preview.selector,
		domPreviewOps: preview.domPreviewOps,
		acceptable: !!preview.candidateSourcePatch,
		patchSummary: preview.candidateSourcePatch?.summary ?? null,
		affectedFiles: preview.candidateSourcePatch?.files.map((f) => f.path) ?? [],
		runId: preview.runId,
		items: preview.items,
		itemPreviews: preview.itemPreviews,
	});
}
