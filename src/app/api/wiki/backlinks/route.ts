export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveBacklinks } from "@/lib/search/backlinks";
import { slugFromPath } from "@/lib/markdown/wikilink";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const url = new URL(request.url);
	const path = url.searchParams.get("path") ?? "";
	const slug = slugFromPath(path);
	if (!slug) return NextResponse.json({ backlinks: [] });

	// Demand-driven: rg prefilter + parse verification, no index, no warm-up.
	// request.signal lets client navigation kill the rg child process.
	const result = await resolveBacklinks(ctx.rootDir, path, {
		limit: 50,
		signal: request.signal,
	});

	const response: Record<string, unknown> = { backlinks: result.backlinks };
	if (result.degraded) response.degraded = result.degraded;

	return NextResponse.json(response);
}
