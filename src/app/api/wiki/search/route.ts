export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { ensureIndexer, ftsSearch } from "@/lib/search/indexer";

const HARD_LIMIT = 200;

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	let body: { query?: unknown; limit?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
	}

	const query = typeof body.query === "string" ? body.query : "";
	const limit = Math.min(
		typeof body.limit === "number" ? body.limit : 30,
		HARD_LIMIT,
	);

	// Lazy init: fire-and-forget. Returns results from whatever is already indexed;
	// index warms up in background on first call per workspace.
	ensureIndexer(ctx.ws.id, ctx.rootDir).catch((e) =>
		console.error("[search] ensureIndexer failed", e),
	);

	const result = ftsSearch(ctx.ws.id, query, limit);

	return NextResponse.json({
		kind: "fts",
		query,
		matches: result.matches,
		truncated: result.truncated,
	});
}
