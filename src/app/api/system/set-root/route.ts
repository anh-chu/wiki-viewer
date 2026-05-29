import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { setRootDir } from "@/lib/root-dir";

export async function POST(request: Request) {
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

	setRootDir(dir);
	return NextResponse.json({ ok: true, path: dir });
}
