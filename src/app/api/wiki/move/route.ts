import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { safeRootPath, getRootDir } from "@/lib/root-dir";
import { moveSidecar } from "@/lib/proof/sidecar";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

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

	const fromPath = safeRootPath(body.from);
	const toPath = safeRootPath(body.to);

	if (!fromPath || !toPath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

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
			const rootDir = getRootDir();
			await moveSidecar(rootDir, body.from, body.to);
		}

		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Move failed" }, { status: 500 });
	}
}
