export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { ensureIndexer, resolveOutlinks } from "@/lib/search/indexer";

// Note: after this change, NO route file imports the DB directly.
// All DB access funnels through indexer.ts and maintenance.ts, which
// is what keeps the ws-isolation defensive test meaningful.

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const url = new URL(request.url);
	const filePath = url.searchParams.get("path") ?? "";
	if (!filePath) {
		return NextResponse.json({ error: "path required" }, { status: 400 });
	}

	// Warm indexer in background (same pattern as backlinks route)
	ensureIndexer(ctx.ws.id, ctx.rootDir).catch((e) =>
		console.error("[outlinks] ensureIndexer failed", e),
	);

	const result = resolveOutlinks(ctx.ws.id, filePath);
	if (!result.indexed) {
		return NextResponse.json({ error: "file not indexed" }, { status: 404 });
	}

	return NextResponse.json({ links: result.links });
}
