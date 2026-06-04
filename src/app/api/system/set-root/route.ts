/**
 * Legacy set-root endpoint — back-compat shim for D1.
 *
 * Behaviour:
 *  1. Validate dir (same as before).
 *  2. Create (or find) a workspace for rootDir in the registry.
 *  3. Keep setting the process-global rootDir + writing lastOpenedPath to config
 *     so the legacy fallback path still works for the existing client.
 *  4. Return { ok, path, workspaceId } — added workspaceId for D2 migration.
 *
 * NOTE: NOT admin-gated here so the current single-user flow is unaffected.
 * The new POST /api/system/workspaces route is admin-gated; D2 will switch the
 * UI to use that endpoint.
 */
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { writeConfig } from "@/lib/config";
import { setRootDir } from "@/lib/root-dir";
import { listWorkspaces, createWorkspace } from "@/lib/workspaces";
import path from "node:path";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: { path?: string } = await request.json();
	const dir = body.path?.trim();
	if (!dir) return NextResponse.json({ error: "Missing path" }, { status: 400 });

	// Verify it exists and is a directory
	try {
		const info = await stat(dir);
		if (!info.isDirectory())
			return NextResponse.json({ error: "Not a directory" }, { status: 400 });
	} catch {
		return NextResponse.json({ error: "Directory not found" }, { status: 404 });
	}

	// Legacy: keep the global + config in sync for the fallback resolver.
	setRootDir(dir);
	await writeConfig({ lastOpenedPath: dir });

	// Find or create a workspace for this rootDir so the registry is populated.
	const resolved = path.resolve(dir);
	const existing = (await listWorkspaces()).find((w) => w.rootDir === resolved);
	const ws = existing ?? (await createWorkspace({ rootDir: dir, createdBy: auth.user.id }));

	return NextResponse.json({ ok: true, path: dir, workspaceId: ws.id });
}
