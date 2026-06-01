import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { safeRootPath } from "@/lib/root-dir";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: { path?: string } = await request.json();
	const rel = body.path;

	if (!rel || typeof rel !== "string" || /[<>:"|?*]/.test(rel)) {
		return NextResponse.json({ error: "Invalid folder path" }, { status: 400 });
	}

	const folderPath = safeRootPath(rel);
	if (!folderPath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		await mkdir(folderPath, { recursive: true });
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json(
			{ error: "Failed to create folder" },
			{ status: 500 },
		);
	}
}
