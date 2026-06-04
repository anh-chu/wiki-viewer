import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

const MIME_MAP: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	ico: "image/x-icon",
	bmp: "image/bmp",
	pdf: "application/pdf",
	txt: "text/plain; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	mp4: "video/mp4",
	webm: "video/webm",
	mov: "video/quicktime",
	m4v: "video/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	aac: "audio/aac",
};

export async function GET(request: Request) {
	const wsx = await resolveWorkspaceForAgent(request);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	const filePath = safeWorkspacePath(rootDir, rel);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	try {
		const info = await stat(filePath);
		if (info.isDirectory())
			return NextResponse.json({ error: "Not a file" }, { status: 400 });
		const ext = path.extname(filePath).slice(1).toLowerCase();
		const contentType = MIME_MAP[ext] ?? "application/octet-stream";
		const buffer = await readFile(filePath);
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
