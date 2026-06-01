import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { getRootDir } from "@/lib/root-dir";
import {
	aggregateActivity,
	ACTIVITY_DEFAULT_LIMIT,
	ACTIVITY_MAX_LIMIT,
} from "@/lib/proof/activity";
import { matchGlob } from "@/lib/proof/glob";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const scopeCheck = enforceScope(auth.agent, { op: "read" });
	if (!scopeCheck.ok) {
		return NextResponse.json({ error: scopeCheck.code, message: scopeCheck.message }, { status: 403 });
	}

	const rootDir = getRootDir();
	if (!rootDir) {
		return NextResponse.json({ error: "ROOT_NOT_SET" }, { status: 503 });
	}

	const url = new URL(req.url);
	const rawLimit = url.searchParams.get("limit");
	const fileFilter = url.searchParams.get("file") ?? undefined;

	// Enforce scope on explicit file query parameter
	if (fileFilter) {
		const fileScope = enforceScope(auth.agent, { filePath: fileFilter, op: "read" });
		if (!fileScope.ok) {
			return NextResponse.json({ error: fileScope.code, message: fileScope.message }, { status: 403 });
		}
	}

	let limit = ACTIVITY_DEFAULT_LIMIT;
	if (rawLimit !== null) {
		const parsed = parseInt(rawLimit, 10);
		if (!isNaN(parsed) && parsed > 0) {
			limit = Math.min(parsed, ACTIVITY_MAX_LIMIT);
		}
	}

	const events = await aggregateActivity(rootDir, { limit, file: fileFilter });

	// Post-aggregation filter: drop events whose path falls outside agent scope
	const scopedPaths = auth.agent.scope.paths;
	const filtered = events.filter((ev) =>
		scopedPaths.some((pattern) => matchGlob(pattern, ev.path)),
	);

	return NextResponse.json({ events: filtered, count: filtered.length });
}
