import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok)
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;

	if (!rel || typeof rel !== "string" || /[<>:"|?*]/.test(rel)) {
		return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
	}
	if (rel.endsWith("/")) {
		return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
	}

	const filePath = safeWorkspacePath(rootDir, rel);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		await stat(filePath);
		return NextResponse.json(
			{ error: "File already exists", path: rel },
			{ status: 409 },
		);
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			return NextResponse.json(
				{ error: "Failed to create file" },
				{ status: 500 },
			);
		}
	}

	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "", "utf-8");
		return NextResponse.json({ ok: true, path: rel });
	} catch {
		return NextResponse.json(
			{ error: "Failed to create file" },
			{ status: 500 },
		);
	}
}
