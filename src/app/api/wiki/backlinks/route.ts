export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { ensureIndexer, resolveBacklinks } from "@/lib/search/indexer";

/** Last path segment, sans .md, used as the wiki-link slug. */
function slugFromPath(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	return base.replace(/\.md$/i, "");
}

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
	return NextResponse.json({ backlinks });
}
