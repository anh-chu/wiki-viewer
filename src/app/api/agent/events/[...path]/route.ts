import { NextResponse } from "next/server";
import { checkAuth, enforceScope, verifyBy } from "@/lib/proof/auth";
import { readSidecar, writeSidecar, emptySidecar } from "@/lib/proof/sidecar";
import { pollEvents } from "@/lib/proof/event-bus";
import { withFileMutex } from "@/lib/proof/mutex";
import { getRootDir, safeRootPath } from "@/lib/root-dir";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function isMarkdown(p: string): boolean {
	return p.endsWith(".md") || p.endsWith(".markdown");
}

function mdPath(segments: string[]): string {
	return segments.join("/");
}

// GET /api/agent/events/<path> — poll events since `after`
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

	const absPath = safeRootPath(rel);
	if (!absPath) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path traversal rejected" }, { status: 400 });
	}

	const scopeCheck = enforceScope(auth.agent, { filePath: rel, op: "read" });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const { searchParams } = new URL(req.url);
	const afterRaw = searchParams.get("after");
	const limitRaw = searchParams.get("limit");

	const after = afterRaw !== null ? parseInt(afterRaw, 10) : 0;
	let limit = limitRaw !== null ? parseInt(limitRaw, 10) : DEFAULT_LIMIT;

	if (Number.isNaN(after) || after < 0) {
		return NextResponse.json({ error: "INVALID_PARAM", message: "after must be a non-negative integer" }, { status: 400 });
	}
	if (Number.isNaN(limit) || limit <= 0) {
		limit = DEFAULT_LIMIT;
	}
	if (limit > MAX_LIMIT) {
		limit = MAX_LIMIT;
	}

	const rootDir = getRootDir();
	const sidecar = (await readSidecar(rootDir, rel)) ?? emptySidecar(rel);
	const events = pollEvents(sidecar, after, limit);
	const lastEventId = sidecar.nextEventId - 1;

	return NextResponse.json({ events, lastEventId });
}

// POST /api/agent/events/<path> — acknowledge events up to upToId
export async function POST(
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

	const absPath = safeRootPath(rel);
	if (!absPath) {
		return NextResponse.json({ error: "INVALID_PATH", message: "Path traversal rejected" }, { status: 400 });
	}

	const scopeCheck = enforceScope(auth.agent, { filePath: rel, op: "mutate" });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	let body: { upToId?: unknown; by?: unknown };
	try {
		body = (await req.json()) as { upToId?: unknown; by?: unknown };
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.upToId !== "number") {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "upToId (number) required" }, { status: 400 });
	}
	if (typeof body.by !== "string" || !body.by) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "by (string) required" }, { status: 400 });
	}

	const byCheck = verifyBy(auth.agent, body.by as string);
	if (!byCheck.ok) {
		return NextResponse.json({ error: byCheck.code, message: byCheck.message }, { status: 403 });
	}

	const rootDir = getRootDir();
	const upToId = body.upToId as number;
	const by = body.by as string;

	await withFileMutex(rel, async () => {
		const sidecar = (await readSidecar(rootDir, rel)) ?? emptySidecar(rel);
		sidecar.lastAck[by] = upToId;
		await writeSidecar(rootDir, rel, sidecar);
	});

	return NextResponse.json({ ok: true });
}
