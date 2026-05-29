import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { ROOT_DIR } from "@/lib/root-dir";

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
	ipynb: "application/json",
	json: "application/json",
	js: "text/javascript",
	ts: "text/plain",
	css: "text/css",
	html: "text/html",
	mmd: "text/plain",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const segments = (await params).path;
	const rel = segments.join("/");

	// Path traversal guard
	const resolved = path.resolve(ROOT_DIR, rel);
	if (resolved !== ROOT_DIR && !resolved.startsWith(ROOT_DIR + path.sep)) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	try {
		const info = await stat(resolved);
		if (info.isDirectory())
			return NextResponse.json({ error: "Not a file" }, { status: 400 });

		const ext = path.extname(resolved).slice(1).toLowerCase();
		const contentType = MIME_MAP[ext] ?? "application/octet-stream";
		const buffer = await readFile(resolved);
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
