import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { getLatestScaffold } from "@/lib/proof/live/scaffold-store";
import { resolveLiveScaffold, stopLiveBridge } from "@/lib/proof/live/web-bridge";
import { stopEngine } from "@/lib/live-engine/supervisor";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";

export const runtime = "nodejs";

interface Body {
	action?: unknown;
	path?: unknown;
	chosenVariantId?: unknown;
	paramValues?: unknown;
}

function isLoopbackRequest(request: Request): boolean {
	const host = request.headers.get("host") ?? new URL(request.url).hostname;
	const hostname = host.replace(/:[0-9]+$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function readPath(request: Request, body: Body): string | null {
	if (typeof body.path === "string") return body.path.slice(0, 4096);
	const value = new URL(request.url).searchParams.get("path");
	return value ? value.slice(0, 4096) : null;
}

function params(value: unknown): Record<string, string | number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const out: Record<string, string | number> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw))) out[key] = raw;
	}
	return out;
}

async function stopLive(workspaceId: string, relPath: string): Promise<void> {
	stopLiveBridge({ workspaceId, relPath });
	await stopEngine({ workspaceId, relPath });
}

export async function POST(request: Request): Promise<NextResponse> {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: "LOOPBACK_REQUIRED" }, { status: 403 });

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
	}
	if (body.action !== "accept" && body.action !== "discard") {
		return NextResponse.json({ error: "INVALID_PARAM", message: "action must be accept or discard" }, { status: 400 });
	}
	const rel = readPath(request, body);
	if (!rel) return NextResponse.json({ error: "PATH_REQUIRED" }, { status: 400 });

	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const target = await resolveWorkspacePath(ctx.rootDir, rel, { deniedSegments: DENIED_SEGMENTS });
	if (!target) return NextResponse.json({ error: "INVALID_PATH" }, { status: 400 });

	const scaffold = getLatestScaffold(ctx.ws.id, target.relPath);
	if (!scaffold) return NextResponse.json({ error: "SCAFFOLD_NOT_FOUND" }, { status: 404 });
	if (scaffold.workspaceId !== ctx.ws.id) return NextResponse.json({ error: "SCAFFOLD_NOT_FOUND" }, { status: 404 });

	const result = await resolveLiveScaffold({
		rootDir: ctx.rootDir,
		workspaceId: ctx.ws.id,
		relPath: target.relPath,
		action: body.action,
		chosenVariantId: typeof body.chosenVariantId === "string" ? body.chosenVariantId : undefined,
		paramValues: params(body.paramValues),
	});
	if (!result.ok) {
		const status = result.code === "SCAFFOLD_NOT_FOUND" ? 404 : 409;
		return NextResponse.json({ error: result.code, detail: result.detail }, { status });
	}
	await stopLive(ctx.ws.id, target.relPath);
	return NextResponse.json({ ok: true, action: result.action, scaffoldId: result.scaffoldId, ...(result.written ? { written: result.written } : {}) });
}
