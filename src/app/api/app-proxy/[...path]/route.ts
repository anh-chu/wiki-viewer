/**
 * Reverse proxy for node-app directories.
 *
 * The request-forwarding core (HTML/CSS rewriting, SPA fallback, service-worker
 * bootstrap, credential stripping) lives in @/lib/app-proxy-core and is shared
 * with the Hosted Apps slug route (`/app/<slug>`). This route resolves the app
 * by URL-prefix within the requested workspace, then delegates forwarding.
 */
import { NextResponse } from "next/server";
import { resolveByPrefix } from "@/lib/app-runner";
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

	const resolved = resolveByPrefix(ctx.ws.id, segments);
	if (!resolved) {
		return NextResponse.json({ error: "APP_NOT_FOUND" }, { status: 404 });
	}

	const { port, relPath, rest } = resolved;
	return forwardToChild(request, {
		port,
		rest,
		proxyBase: `/api/app-proxy/${relPath}`,
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
