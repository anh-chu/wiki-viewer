import { exec } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { getRootDir } from "@/lib/root-dir";

export async function POST(request: Request) {
	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	// Path traversal guard
	const resolved = path.resolve(getRootDir(), rel);
	if (resolved !== getRootDir() && !resolved.startsWith(getRootDir() + path.sep))
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	// Open in system file manager
	const platform = process.platform;
	const cmd =
		platform === "darwin"
			? `open -R "${resolved}"`
			: platform === "win32"
				? `explorer /select,"${resolved}"`
				: `xdg-open "${path.dirname(resolved)}"`;

	exec(cmd, () => {});
	return NextResponse.json({ ok: true });
}
