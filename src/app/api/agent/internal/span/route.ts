/**
 * Internal span accept/revert. Callable by owner (browser cookie) or any agent
 * with mutate scope. The `by` field on emitted events is the authenticated agent id.
 */
import { readFile, writeFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { revertProofSpan } from "@/lib/proof/proof-span";
import { readSidecar, writeSidecar, emptySidecar } from "@/lib/proof/sidecar";
import { withFileMutex } from "@/lib/proof/mutex";
import { emitEvents } from "@/lib/proof/event-bus";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import { checkAuth, enforceScope } from "@/lib/proof/auth";

export const runtime = "nodejs";

function isMarkdown(p: string): boolean {
	return p.endsWith(".md") || p.endsWith(".markdown");
}

/**
 * Remove the wrapper for a specific spanId while keeping inner content.
 */
function acceptSpanById(markdown: string, spanId: string): string {
	const escapedId = spanId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(
		`<proof-span\\b[^>]*\\bid="${escapedId}"[^>]*>([\\s\\S]*?)<\\/proof-span>`,
		"g",
	);
	return markdown.replace(re, "$1");
}

export async function POST(req: Request): Promise<NextResponse> {
	const authResult = await checkAuth(req);
	if (!authResult.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	let body: { path?: unknown; spanId?: unknown; action?: unknown };
	try {
		body = (await req.json()) as { path?: unknown; spanId?: unknown; action?: unknown };
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.path !== "string" || !body.path) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "path (string) required" }, { status: 400 });
	}
	if (typeof body.spanId !== "string" || !body.spanId) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "spanId (string) required" }, { status: 400 });
	}
	if (body.action !== "accept" && body.action !== "revert") {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "action must be 'accept' or 'revert'" }, { status: 400 });
	}

	const rel = body.path as string;
	const spanId = body.spanId as string;
	const action = body.action as "accept" | "revert";

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

	const scopeCheck = enforceScope(authResult.agent, { filePath: rel, op: "mutate", workspaceId: ws.id });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const actorId = authResult.agent.id;

	let notFound = false;
	try {
		await withFileMutex(`${rootDir}\u0000${rel}`, async () => {
			let content: string;
			try {
				content = await readFile(absPath, "utf-8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					notFound = true;
					return;
				}
				throw err;
			}

			const newContent = action === "accept"
				? acceptSpanById(content, spanId)
				: revertProofSpan(content, spanId);

			await writeFile(absPath, newContent, "utf-8");

			const sidecar = (await readSidecar(rootDir, rel)) ?? emptySidecar(rel);
			emitEvents(sidecar, [{
				type: action === "accept" ? "span.accepted" : "span.reverted",
				at: new Date().toISOString(),
				by: actorId === "owner" ? "human" : actorId,
				spanId,
			}]);
			await writeSidecar(rootDir, rel, sidecar);
		});
	} catch (err) {
		return NextResponse.json({ error: "INTERNAL_ERROR", message: String(err) }, { status: 500 });
	}

	if (notFound) {
		return NextResponse.json({ error: "NOT_FOUND", message: "File not found" }, { status: 404 });
	}

	return NextResponse.json({ ok: true });
}
