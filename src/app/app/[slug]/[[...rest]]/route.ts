import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { getBySlug } from "@/lib/hosted-apps";
import { contentTypeForPath } from "@/lib/mime";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";

/**
 * Short, stable public URL for a hosted app: /app/<slug>/<...rest>.
 *
 * Scope for this ticket (OPS-52 / T1) is `html`-type entries only. The slug
 * maps to a {workspaceId, relPath} in the registry; the directory is served
 * dir-aware (defaulting to index.html), reusing the same path-containment and
 * workspace-access checks as /api/assets. Relative assets inside the page
 * resolve against the stable /app/<slug>/ prefix, so no query-string scope is
 * needed. An unknown slug returns 404.
 *
 * Node-type proxying is added by a later ticket (OPS-53); node entries 404 here.
 */

/** Inject `ws=<id>` so resolveWorkspaceForUser authenticates + checks access. */
function withWorkspace(req: Request, workspaceId: string): Request {
	const url = new URL(req.url);
	url.searchParams.set("ws", workspaceId);
	return new Request(url.toString(), req);
}

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ slug: string; rest?: string[] }> },
) {
	const { slug, rest } = await params;

	const entry = await getBySlug(slug);
	if (!entry || entry.type !== "html") {
		return NextResponse.json({ error: "APP_NOT_FOUND" }, { status: 404 });
	}

	// Authenticate + enforce access to the entry's OWNING workspace.
	const wsx = await resolveWorkspaceForUser(withWorkspace(request, entry.workspaceId));
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const restPath = (rest ?? []).filter(Boolean).join("/");
	const baseRel = [entry.relPath, restPath].filter(Boolean).join("/");

	let resolved = await resolveWorkspacePath(rootDir, baseRel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	try {
		let info = await stat(resolved.absolutePath);
		// Dir-aware: default to index.html inside a directory.
		if (info.isDirectory()) {
			const indexRel = [baseRel, "index.html"].filter(Boolean).join("/");
			const indexResolved = await resolveWorkspacePath(rootDir, indexRel, {
				deniedSegments: DENIED_SEGMENTS,
			});
			if (!indexResolved) {
				return NextResponse.json({ error: "Not found" }, { status: 404 });
			}
			resolved = indexResolved;
			info = await stat(resolved.absolutePath);
			if (info.isDirectory()) {
				return NextResponse.json({ error: "Not found" }, { status: 404 });
			}
		}

		const contentType = contentTypeForPath(resolved.absolutePath);
		const buffer = await readFile(resolved.absolutePath);
		return new Response(new Uint8Array(buffer), {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "private, max-age=60",
			},
		});
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}

export const dynamic = "force-dynamic";
