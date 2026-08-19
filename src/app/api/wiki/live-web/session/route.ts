import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { startEngine, stopEngine } from "@/lib/live-engine/supervisor";

export const runtime = "nodejs";

interface SessionBody {
	path?: unknown;
}

function isLoopbackRequest(request: Request): boolean {
	const host = request.headers.get("host") ?? new URL(request.url).hostname;
	const hostname = host
		.replace(/:[0-9]+$/, "")
		.replace(/^\[(.*)\]$/, "$1")
		.toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function readPath(request: Request, body?: SessionBody): string | null {
	if (typeof body?.path === "string") return body.path.slice(0, 4096);
	const value = new URL(request.url).searchParams.get("path");
	return value ? value.slice(0, 4096) : null;
}

async function resolveTarget(request: Request, rel: string) {
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return { response: NextResponse.json({ error: ctx.code }, { status: ctx.status }) };
	const target = await resolveWorkspacePath(ctx.rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!target) {
		return { response: NextResponse.json({ error: "INVALID_PATH" }, { status: 400 }) };
	}
	try {
		const info = await stat(target.absolutePath);
		return {
			ctx,
			relPath: target.relPath,
			appRoot: info.isDirectory() ? target.absolutePath : path.dirname(target.absolutePath),
		};
	} catch {
		return { response: NextResponse.json({ error: "FILE_NOT_FOUND" }, { status: 404 }) };
	}
}

export async function POST(request: Request): Promise<NextResponse> {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	if (!isLoopbackRequest(request)) {
		return NextResponse.json({ error: "LOOPBACK_REQUIRED" }, { status: 403 });
	}

	let body: SessionBody;
	try {
		body = (await request.json()) as SessionBody;
	} catch {
		return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
	}
	const rel = readPath(request, body);
	if (!rel) return NextResponse.json({ error: "PATH_REQUIRED" }, { status: 400 });

	const target = await resolveTarget(request, rel);
	if (target.response) return target.response;
	try {
		const engine = await startEngine({
			workspaceId: target.ctx.ws.id,
			relPath: target.relPath,
			appRoot: target.appRoot,
		});
		return NextResponse.json({ ok: true, port: engine.port, token: engine.token });
	} catch {
		return NextResponse.json({ error: "ENGINE_START_FAILED" }, { status: 500 });
	}
}

export async function DELETE(request: Request): Promise<NextResponse> {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	if (!isLoopbackRequest(request)) {
		return NextResponse.json({ error: "LOOPBACK_REQUIRED" }, { status: 403 });
	}

	let body: SessionBody | undefined;
	try {
		body = (await request.json()) as SessionBody;
	} catch {
		/* DELETE may carry path as a query parameter. */
	}
	const rel = readPath(request, body);
	if (!rel) return NextResponse.json({ error: "PATH_REQUIRED" }, { status: 400 });

	const target = await resolveTarget(request, rel);
	if (target.response) return target.response;
	await stopEngine({ workspaceId: target.ctx.ws.id, relPath: target.relPath });
	return NextResponse.json({ ok: true });
}
