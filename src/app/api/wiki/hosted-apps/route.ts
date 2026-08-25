import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { getStatus } from "@/lib/app-runner";
import {
	createHostedApp,
	deleteHostedApp,
	type HostedAppType,
	listHostedApps,
} from "@/lib/hosted-apps";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { getWorkspace, safeWorkspacePath } from "@/lib/workspaces";

/**
 * Registry-backed management layer for hosted apps.
 *
 * Session-gated. State-changing calls (create/delete) perform the CSRF Origin
 * check and the existing app-runner authorization gate.
 */

function canManageApps(ctx: { isAdmin: boolean }): boolean {
	// WIKI_NO_AUTH=1 keeps local single-user behavior.
	// WIKI_ALLOW_APP_RUNNER=1 is an explicit operator opt-in for non-admin launch.
	return (
		process.env.WIKI_NO_AUTH === "1" ||
		process.env.WIKI_ALLOW_APP_RUNNER === "1" ||
		ctx.isAdmin
	);
}

// GET /api/wiki/hosted-apps — list all hosted apps (slugs are global)
export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	const apps = await listHostedApps();
	const enriched = await Promise.all(apps.map(async (app) => {
		if (app.type !== "node") return app;
		const status = getStatus(app.workspaceId, app.relPath);
		const ws = await getWorkspace(app.workspaceId);
		const abs = ws ? safeWorkspacePath(ws.rootDir, app.relPath) : null;
		if (!abs || !existsSync(abs)) {
			return {
				...app,
				...status,
				status: "missing" as const,
				error: "Hosted app source directory is missing",
				lastError: "Hosted app source directory is missing",
			};
		}
		return { ...app, ...status };
	}));
	return NextResponse.json({ apps: enriched });
}

// POST /api/wiki/hosted-apps  { slug, type?, path, script?, persist? }
export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	if (!canManageApps(ctx)) {
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
	}

	let body: {
		slug?: string;
		type?: string;
		path?: string;
		script?: string;
		persist?: boolean;
	};
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const slug = typeof body.slug === "string" ? body.slug : "";
	const type = (body.type ?? "html") as HostedAppType;
	if (type !== "html" && type !== "node") {
		return NextResponse.json({ error: "INVALID_TYPE" }, { status: 400 });
	}
	const relPath = typeof body.path === "string" ? body.path : "";

	const result = await createHostedApp({
		slug,
		type,
		workspaceId: ctx.ws.id,
		relPath,
		script: typeof body.script === "string" ? body.script : undefined,
		persist: typeof body.persist === "boolean" ? body.persist : undefined,
	});

	if (result.ok) {
		return NextResponse.json({ app: result.app }, { status: 201 });
	}

	if (result.code === "SLUG_TAKEN") {
		const owner = await getWorkspace(result.ownerWorkspaceId);
		const ownerName = owner?.name ?? result.ownerWorkspaceId;
		return NextResponse.json(
			{
				error: "SLUG_TAKEN",
				message: `Slug "${slug}" is already hosted by workspace "${ownerName}"`,
			},
			{ status: 409 },
		);
	}

	return NextResponse.json({ error: result.code }, { status: 400 });
}

// DELETE /api/wiki/hosted-apps  { slug }
export async function DELETE(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	if (!canManageApps(ctx)) {
		return NextResponse.json({ error: "ADMIN_REQUIRED" }, { status: 403 });
	}

	let body: { slug?: string };
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const slug = body.slug;
	if (!slug || typeof slug !== "string") {
		return NextResponse.json({ error: "Missing slug" }, { status: 400 });
	}

	const removed = await deleteHostedApp(slug);
	if (!removed) {
		return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}
