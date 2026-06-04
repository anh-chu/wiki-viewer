import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { readRegistry } from "@/lib/proof/registry";
import { listPendingRegistrations } from "@/lib/proof/pending";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const wsx = await resolveWorkspaceForAgent(req);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { ws, rootDir } = wsx;

	const scopeCheck = enforceScope(auth.agent, { op: "read", workspaceId: ws.id });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const registry = await readRegistry();
	const registeredAgents = registry?.agents.length ?? 0;
	const pendingRegistrations = listPendingRegistrations().length;

	return NextResponse.json({
		rateLimit: Number(process.env.AGENT_RATE_LIMIT) || 60,
		root: rootDir,
		registeredAgents,
		pendingRegistrations,
	});
}
