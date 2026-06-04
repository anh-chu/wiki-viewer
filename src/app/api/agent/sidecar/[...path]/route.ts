import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { readSidecar, emptySidecar } from "@/lib/proof/sidecar";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export const runtime = "nodejs";

function isMarkdown(p: string): boolean {
	return p.endsWith(".md") || p.endsWith(".markdown");
}

function mdPath(segments: string[]): string {
	return segments.join("/");
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const { path: segments } = await params;
	const rel = mdPath(segments);

	if (rel.startsWith(".proof")) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path must not be under .proof" }, { status: 400 });
	}
	if (!isMarkdown(rel)) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path must be .md or .markdown" }, { status: 400 });
	}

	const wsx = await resolveWorkspaceForAgent(req);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { ws, rootDir } = wsx;

	const absPath = safeWorkspacePath(rootDir, rel);
	if (!absPath) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path traversal rejected" }, { status: 400 });
	}

	const scopeCheck = enforceScope(auth.agent, { filePath: rel, op: "read", workspaceId: ws.id });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const sidecar = (await readSidecar(rootDir, rel)) ?? emptySidecar(rel);

	return NextResponse.json(sidecar);
}
