export const runtime = "nodejs";

import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { extractWikiLinks } from "@/lib/markdown/wikilink";
import { listSlugs } from "@/lib/wiki/slug-listing";

interface OutlinkEntry {
	slug: string;
	resolved_path: string | null;
	exists: boolean;
}

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const url = new URL(request.url);
	const filePath = url.searchParams.get("path") ?? "";
	if (!filePath) {
		return NextResponse.json({ error: "path required" }, { status: 400 });
	}

	// Same traversal guard as every sibling wiki route.
	const absPath = safeWorkspacePath(ctx.rootDir, filePath);
	if (!absPath) {
		return NextResponse.json({ error: "invalid path" }, { status: 400 });
	}

	let text: string;
	try {
		text = await readFile(absPath, "utf8");
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EISDIR") {
			return NextResponse.json({ error: "file not found" }, { status: 404 });
		}
		throw e;
	}

	// One entry per distinct slug, ascending — matches the old ORDER BY target_slug.
	const slugs = [...new Set(extractWikiLinks(text).map((o) => o.slug))].sort();
	if (slugs.length === 0) return NextResponse.json({ links: [] });

	// Bounded single-level listing supplies slug -> workspace-relative path.
	const { slugMap } = await listSlugs(ctx.rootDir);

	const links: OutlinkEntry[] = slugs.map((slug) => {
		const resolved_path = slugMap.get(slug) ?? null;
		return { slug, resolved_path, exists: resolved_path !== null };
	});

	return NextResponse.json({ links });
}
