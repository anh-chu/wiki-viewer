import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { contentTypeForPath } from "@/lib/mime";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const wsx = await resolveWorkspaceForUser(request);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const segments = (await params).path;
	const rel = segments.join("/");

	const resolved = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	try {
		const info = await stat(resolved.absolutePath);
		if (info.isDirectory())
			return NextResponse.json({ error: "Not a file" }, { status: 400 });

		const contentType = contentTypeForPath(resolved.absolutePath);
		const buffer = await readFile(resolved.absolutePath);
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType,
				"Cache-Control": "private, max-age=60",
			},
		});
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}
