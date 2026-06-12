/**
 * Agent files route — GET snapshot, POST apply-ops.
 *
 * Sample curl (§10 step 1 — read snapshot):
 *   curl -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
 *        http://localhost:3000/api/agent/files/notes.md
 *
 * Sample curl (§10 step 2 — apply ops):
 *   curl -X POST \
 *        -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
 *        -H "Content-Type: application/json" \
 *        -H "Idempotency-Key: req-$(uuidgen)" \
 *        -d '{"baseRevision":0,"by":"ai:claude","ops":[{"type":"block.append","markdown":"Hello world."}]}' \
 *        http://localhost:3000/api/agent/files/notes.md
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope, verifyBy } from "@/lib/proof/auth";
import { applyOps, readSnapshot } from "@/lib/proof/ops-applier";
import { idempotency } from "@/lib/proof/idempotency";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";
import type { Op } from "@/lib/proof/types";
import { checkAndConsume } from "@/lib/proof/rate-limit";
import { computeCollabState } from "@/lib/proof/collab-state";

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

	const snapshot = await readSnapshot(rootDir, rel);
	if (!snapshot) {
		return NextResponse.json({ error: "NOT_FOUND", message: "File not found" }, { status: 404 });
	}

	const collab = await computeCollabState(rootDir, rel);
	const collabHeaders: Record<string, string> = {
		"X-Collab-State": collab.state,
		"X-Collab-Revision": String(collab.revision),
	};
	if (collab.snapshotUrl) {
		collabHeaders["X-Collab-Snapshot"] = collab.snapshotUrl;
	}

	return NextResponse.json(snapshot, { headers: collabHeaders });
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const idempotencyKey = req.headers.get("idempotency-key");
	if (!idempotencyKey) {
		return NextResponse.json(
			{ error: "MISSING_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required" },
			{ status: 400 },
		);
	}

	const { path: segments } = await params;
	const rel = mdPath(segments);

	if (rel.startsWith(".proof")) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path must not be under .proof" }, { status: 400 });
	}
	if (!isMarkdown(rel)) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path must be .md or .markdown" }, { status: 400 });
	}

	const wsx = await resolveWorkspaceForAgent(req, "write");
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { ws, rootDir } = wsx;

	const absPath = safeWorkspacePath(rootDir, rel);
	if (!absPath) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path traversal rejected" }, { status: 400 });
	}

	// Read body for idempotency hash
	let rawBody: string;
	try {
		rawBody = await req.text();
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Could not read request body" }, { status: 400 });
	}

	const payloadHash = createHash("sha256").update(rawBody, "utf8").digest("hex");

	// Check idempotency cache
	const cached = idempotency.get(`${rootDir}\u0000${idempotencyKey}`);
	if (cached) {
		if (cached.payloadHash !== payloadHash) {
			return NextResponse.json(
				{ error: "IDEMPOTENCY_KEY_REUSED", message: "Same key, different payload" },
				{ status: 409 },
			);
		}
		return new NextResponse(cached.body, {
			status: cached.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	let body: { baseRevision?: unknown; by?: unknown; ops?: unknown };
	try {
		body = JSON.parse(rawBody) as { baseRevision?: unknown; by?: unknown; ops?: unknown };
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.baseRevision !== "number") {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "baseRevision (number) required" }, { status: 400 });
	}
	if (typeof body.by !== "string" || !body.by) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "by (string) required" }, { status: 400 });
	}
	if (!Array.isArray(body.ops)) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "ops (array) required" }, { status: 400 });
	}

	const scopeCheck = enforceScope(auth.agent, { filePath: rel, op: "mutate", workspaceId: ws.id });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const byCheck = verifyBy(auth.agent, body.by as string);
	if (!byCheck.ok) {
		return NextResponse.json({ error: byCheck.code, message: byCheck.message }, { status: 403 });
	}

	// Rate-limit mutations: count ops (all ops are mutations in this route)
	const opCount = (body.ops as Op[]).length || 1;
	const rl = checkAndConsume(body.by as string, opCount);
	if (!rl.ok) {
		const retryAfterSec = Math.ceil(rl.retryAfterMs / 1000);
		return new NextResponse(
			JSON.stringify({ error: "RATE_LIMITED", retryAfterMs: rl.retryAfterMs }),
			{
				status: 429,
				headers: {
					"Content-Type": "application/json",
					"Retry-After": String(retryAfterSec),
				},
			},
		);
	}

	const result = await applyOps({
		rootDir,
		mdPath: rel,
		baseRevision: body.baseRevision as number,
		by: body.by as string,
		ops: body.ops as Op[],
	});

	let responseBody: string;
	let status: number;

	if (result.ok) {
		status = 200;
		responseBody = JSON.stringify(result.snapshot);
	} else {
		status = result.status;
		const payload: Record<string, unknown> = { error: result.code, message: result.message };
		if (result.snapshot) payload.snapshot = result.snapshot;
		responseBody = JSON.stringify(payload);
	}

	idempotency.set(`${rootDir}\u0000${idempotencyKey}`, { payloadHash, status, body: responseBody });

	return new NextResponse(responseBody, {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
