import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { listSlugs } from "@/lib/wiki/slug-listing";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	try {
		// Bounded, NON-RECURSIVE listing of root + entities/concepts/comparisons.
		const { buckets } = await listSlugs(rootDir);
		return NextResponse.json(buckets, {
			headers: { "Cache-Control": "private, max-age=10" },
		});
	} catch {
		return NextResponse.json(
			{ error: "Failed to list slugs" },
			{ status: 500 },
		);
	}
}
