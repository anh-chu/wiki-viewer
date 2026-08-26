/**
 * Reverse proxy for node-app directories.
 *
 * The request-forwarding core (HTML/CSS rewriting, SPA fallback, service-worker
 * bootstrap, credential stripping) lives in @/lib/app-proxy-core and is shared
 * with the Hosted Apps slug route (`/app/<slug>`). This route resolves the app
 * by URL-prefix within the requested workspace, then delegates forwarding.
 */
import { NextResponse } from "next/server";
import { ROOT_APP_PROXY_SEGMENT, resolveByPrefix, resolveRootApp } from "@/lib/app-runner";
import { forwardToChild } from "@/lib/app-proxy-core";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";

async function handleProxy(
	request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
	const ctx = await resolveWorkspaceForUser(request, "read");
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}

	const segments = (await params).path ?? [];

	// A workspace-root app is addressed via the reserved `~root` sentinel, since
	// it has no path prefix of its own to match on.
	const isRoot = segments[0] === ROOT_APP_PROXY_SEGMENT;
	const resolved = isRoot
		? resolveRootApp(ctx.ws.id, segments.slice(1))
		: resolveByPrefix(ctx.ws.id, segments);
	if (!resolved) {
		return NextResponse.json({ error: "APP_NOT_FOUND" }, { status: 404 });
	}

	const { port, relPath, rest } = resolved;
	return forwardToChild(request, {
		port,
		rest,
		proxyBase: isRoot ? `/api/app-proxy/${ROOT_APP_PROXY_SEGMENT}` : `/api/app-proxy/${relPath}`,
	});
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const DELETE = handleProxy;
export const PATCH = handleProxy;
export const HEAD = handleProxy;
export const OPTIONS = handleProxy;
export const dynamic = "force-dynamic";
