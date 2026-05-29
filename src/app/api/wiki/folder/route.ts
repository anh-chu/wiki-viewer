import { mkdir } from "node:fs/promises";
import { NextResponse } from "next/server";
import { safeRootPath } from "@/lib/root-dir";

export async function POST(request: Request) {
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
