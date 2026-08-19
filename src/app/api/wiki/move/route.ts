import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { moveSidecar } from "@/lib/proof/sidecar";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { from?: string; to?: string } = await request.json();
	if (
		!body.from ||
		!body.to ||
		typeof body.from !== "string" ||
		typeof body.to !== "string"
	) {
		return NextResponse.json(
			{ error: "Missing from/to paths" },
			{ status: 400 },
		);
	}

	const fromRes = await resolveWorkspacePath(rootDir, body.from, {
		deniedSegments: DENIED_SEGMENTS,
	});
	const toRes = await resolveWorkspacePath(rootDir, body.to, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});

	if (!fromRes || !toRes)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const fromPath = fromRes.absolutePath;
	const toPath = toRes.absolutePath;

	if (toPath.startsWith(fromPath + path.sep) || toPath === fromPath) {
		return NextResponse.json(
			{ error: "Cannot move a folder into itself" },
			{ status: 400 },
		);
	}

	try {
		await stat(fromPath);
	} catch {
		return NextResponse.json({ error: "Source not found" }, { status: 404 });
	}

	try {
		await rename(fromPath, toPath);

		// Fix latent bug: sidecar was orphaned on .md renames (R3)
		const fromExt = path.extname(body.from).toLowerCase();
		if (fromExt === ".md" || fromExt === ".markdown") {
			await moveSidecar(rootDir, body.from, body.to);
		}

		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Move failed" }, { status: 500 });
	}
}
