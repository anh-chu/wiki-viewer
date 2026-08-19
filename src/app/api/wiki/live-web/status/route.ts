import { NextResponse } from "next/server";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { getEngine } from "@/lib/live-engine/supervisor";
import { getSession } from "@/lib/proof/live/store";
import { getLatestScaffold } from "@/lib/proof/live/scaffold-store";
import { getLiveBridgeStatus } from "@/lib/proof/live/web-bridge";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";

export const runtime = "nodejs";

function isLoopbackRequest(request: Request): boolean {
	const host = request.headers.get("host") ?? new URL(request.url).hostname;
	const hostname = host.replace(/:[0-9]+$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export async function GET(request: Request): Promise<NextResponse> {
	if (!isLoopbackRequest(request)) return NextResponse.json({ error: "LOOPBACK_REQUIRED" }, { status: 403 });
	const ctx = await resolveWorkspaceForUser(request, "read");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const rel = new URL(request.url).searchParams.get("path");
	if (!rel) return NextResponse.json({ error: "PATH_REQUIRED" }, { status: 400 });
	const target = await resolveWorkspacePath(ctx.rootDir, rel.slice(0, 4096), { deniedSegments: DENIED_SEGMENTS });
	if (!target) return NextResponse.json({ error: "INVALID_PATH" }, { status: 400 });

	const scaffold = getLatestScaffold(ctx.ws.id, target.relPath);
	if (!scaffold) return NextResponse.json({ error: "SCAFFOLD_NOT_FOUND" }, { status: 404 });
	const key = { workspaceId: ctx.ws.id, relPath: target.relPath };
	const engine = getEngine(key);
	const bridge = getLiveBridgeStatus(key);
	const session = getSession(scaffold.sessionId);
	const engineLive = !!engine && engine.state === "running";
	const recoverable = !engineLive && (scaffold.state === "open" || scaffold.state === "ready");

	return NextResponse.json({
		ok: true,
		path: target.relPath,
		scaffold: {
			id: scaffold.id,
			sessionId: scaffold.sessionId,
			state: scaffold.state,
			ready: !!scaffold.scaffold,
			chosenVariantId: scaffold.chosenVariantId,
		},
		session,
		engine: engine ? { state: engine.state, port: engine.port, generation: engine.generation } : null,
		bridge,
		engineLive,
		recoverable,
	});
}
