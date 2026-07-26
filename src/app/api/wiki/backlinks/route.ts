export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { ensureIndexer, resolveBacklinks, indexedFileCount } from "@/lib/search/indexer";
import { slugFromPath } from "@/lib/markdown/wikilink";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const url = new URL(request.url);
	const path = url.searchParams.get("path") ?? "";
	const slug = slugFromPath(path);
	if (!slug) return NextResponse.json({ backlinks: [] });

	// Lazy init: returns whatever is already indexed; warms up in background.
	ensureIndexer(ctx.ws.id, ctx.rootDir).catch((e) =>
		console.error("[backlinks] ensureIndexer failed", e),
	);

	const backlinks = resolveBacklinks(ctx.ws.id, slug, path, 50);

	const response: Record<string, unknown> = { backlinks };

	// Distinguish "no backlinks" from "not indexed yet".
	if (indexedFileCount(ctx.ws.id) === 0) {
		response.degraded = "indexing";
	}

	return NextResponse.json(response);
}
