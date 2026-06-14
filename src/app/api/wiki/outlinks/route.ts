export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getSearchDb } from "@/lib/search/search-db";
import { ensureIndexer } from "@/lib/search/indexer";

// Matches [[slug]], [[slug|alias]], [[slug#anchor]] — slug is [a-z0-9-]+
const WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|[^\]#|]+|#[a-z0-9-]+)?\]\]/gi;

function slugFromPath(filePath: string): string {
	const base = filePath.split("/").pop() ?? filePath;
	return base.replace(/\.md$/i, "").toLowerCase();
}

export interface OutlinkEntry {
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

	// Warm indexer in background (same pattern as backlinks route)
	ensureIndexer(ctx.ws.id, ctx.rootDir).catch((e) =>
		console.error("[outlinks] ensureIndexer failed", e),
	);

	const db = getSearchDb();

	// Read body from search index (avoids a file-system read)
	const row = db
		.prepare(`SELECT body FROM docs WHERE ws = ? AND path = ?`)
		.get(ctx.ws.id, filePath) as { body: string } | undefined;

	if (!row) {
		return NextResponse.json({ error: "file not indexed" }, { status: 404 });
	}

	// Extract unique slugs from [[wikilinks]]
	const slugs = new Set<string>();
	const re = new RegExp(WIKILINK_RE.source, "gi");
	let match: RegExpExecArray | null;
	while ((match = re.exec(row.body)) !== null) {
		if (match[1]) slugs.add(match[1].toLowerCase());
	}

	if (slugs.size === 0) {
		return NextResponse.json({ links: [] });
	}

	// Build slug → path map from indexed .md files (single DB pass)
	const allMdPaths = db
		.prepare(`SELECT path FROM docs WHERE ws = ? AND path LIKE '%.md'`)
		.all(ctx.ws.id) as { path: string }[];

	const pathBySlug = new Map<string, string>();
	for (const { path } of allMdPaths) {
		pathBySlug.set(slugFromPath(path), path);
	}

	const links: OutlinkEntry[] = Array.from(slugs).map((slug) => {
		const resolved_path = pathBySlug.get(slug) ?? null;
		return { slug, resolved_path, exists: resolved_path !== null };
	});

	return NextResponse.json({ links });
}
