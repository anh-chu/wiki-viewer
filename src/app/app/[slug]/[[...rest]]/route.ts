/**
 * Hosted Apps slug route — the short, stable public path for a hosted app.
 *
 *   /app/<slug>/<...rest>
 *
 * Resolution is by slug, independent of how deep the source directory is or
 * which workspace owns it. The route authenticates the user and enforces access
 * to the entry's OWNING workspace (not ?ws=), then branches on entry type:
 *
 *   - node: proxy to the running child via the shared forwarding core. The child
 *     port is resolved from the app runner on EVERY request (never baked into a
 *     URL, cached state, or the service worker), so a restart that picks a fresh
 *     port does not break an already-open client. The proxyBase is `/app/<slug>`.
 *   - html: serve files dir-aware from the workspace, defaulting to index.html.
 *
 * An unknown slug is 404. A node entry that is not running returns 503 with a
 * small explanatory page rather than proxying to a dead port.
 */
import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { forwardToChild } from "@/lib/app-proxy-core";
import { resolveHostedTarget } from "@/lib/hosted-apps-resolve";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { contentTypeForPath } from "@/lib/mime";
import { isAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/server";
import { getWorkspace, userCanAccess } from "@/lib/workspaces";

async function authorizeWorkspace(
	request: Request,
	workspaceId: string,
): Promise<NextResponse | null> {
	const ws = await getWorkspace(workspaceId);
	if (!ws) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });

	if (process.env.WIKI_NO_AUTH === "1") return null;

	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	const admin = await isAdmin(auth.user.id, auth.user.email);
	if (!userCanAccess(ws, auth.user.id, admin)) {
		return NextResponse.json({ error: "WORKSPACE_FORBIDDEN" }, { status: 403 });
	}
	return null;
}

function notRunningPage(slug: string): Response {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>App stopped</title>` +
			`<body style="font:14px system-ui;padding:2rem;color:#444">` +
			`<h1 style="font-size:1.1rem">This app is not running</h1>` +
			`<p>The hosted app <code>${slug}</code> is stopped. Start it from the ` +
			`Hosted Apps section in the sidebar, then reload.</p></body>`,
		{ status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);
}

async function serveHtml(
	rootDir: string,
	relPath: string,
	restSegments: string[],
): Promise<Response> {
	const sub = restSegments.filter(Boolean).join("/");
	// Default document for the directory root.
	const joined = [relPath, sub].filter(Boolean).join("/");
	const rel = sub === "" || sub.endsWith("/") ? `${joined}/index.html`.replace(/\/+/g, "/") : joined;

	const resolved = await resolveWorkspacePath(rootDir, rel, { deniedSegments: DENIED_SEGMENTS });
	if (!resolved) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		const info = await stat(resolved.absolutePath);
		if (info.isDirectory()) {
			// Directory hit without trailing index — try its index.html.
			const idx = await resolveWorkspacePath(rootDir, `${rel}/index.html`, {
				deniedSegments: DENIED_SEGMENTS,
			});
			if (!idx) return NextResponse.json({ error: "Not found" }, { status: 404 });
			const buf = await readFile(idx.absolutePath);
			return new Response(new Uint8Array(buf), {
				headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
			});
		}
		const buf = await readFile(resolved.absolutePath);
		return new Response(new Uint8Array(buf), {
			headers: {
				"Content-Type": contentTypeForPath(resolved.absolutePath),
				"Cache-Control": "private, max-age=60",
			},
		});
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}

async function handle(
	request: Request,
	{ params }: { params: Promise<{ slug: string; rest?: string[] }> },
): Promise<Response> {
	const { slug, rest } = await params;

	const target = await resolveHostedTarget(slug);
	if (!target) return NextResponse.json({ error: "SLUG_NOT_FOUND" }, { status: 404 });

	const denied = await authorizeWorkspace(request, target.workspaceId);
	if (denied) return denied;

	const ws = await getWorkspace(target.workspaceId);
	if (!ws) return NextResponse.json({ error: "WORKSPACE_NOT_FOUND" }, { status: 404 });

	if (target.kind === "html") {
		return serveHtml(ws.rootDir, target.relPath, rest ?? []);
	}

	// node branch
	if (!target.port || target.status !== "running") {
		return notRunningPage(slug);
	}

	const restPath = "/" + (rest ?? []).filter(Boolean).join("/");
	return forwardToChild(request, {
		port: target.port,
		rest: restPath,
		proxyBase: `/app/${slug}`,
	});
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
export const HEAD = handle;
export const OPTIONS = handle;
export const dynamic = "force-dynamic";
