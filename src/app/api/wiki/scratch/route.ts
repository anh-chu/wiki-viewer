import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import {
	extFromFilename,
	newScratchRelPath,
	sanitizeExt,
	SCRATCH_MAX_BYTES,
} from "@/lib/scratch/config";
import { sweepScratch } from "@/lib/scratch/sweep";

const DENIED_SEGMENTS = [".proof", ".git"];

async function writeScratch(
	rootDir: string,
	ext: string,
	data: string | Buffer,
): Promise<{ path: string; name: string } | null> {
	const rel = newScratchRelPath(ext);
	const res = await resolveWorkspacePath(rootDir, rel, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!res) return null;
	await mkdir(path.dirname(res.absolutePath), { recursive: true });
	await writeFile(res.absolutePath, data);
	return { path: res.relPath, name: path.basename(res.relPath) };
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok)
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	// Best-effort TTL sweep before creating a new scratch file.
	await sweepScratch(rootDir).catch(() => 0);

	const contentType = request.headers.get("content-type") ?? "";

	// Binary/dropped file.
	if (contentType.includes("multipart/form-data")) {
		const form = await request.formData();
		const file = form.get("file");
		if (!(file instanceof File)) {
			return NextResponse.json({ error: "Missing file" }, { status: 400 });
		}
		if (file.size > SCRATCH_MAX_BYTES) {
			return NextResponse.json({ error: "File too large" }, { status: 413 });
		}
		const buf = Buffer.from(await file.arrayBuffer());
		const ext = extFromFilename(file.name);
		const out = await writeScratch(rootDir, ext, buf);
		if (!out)
			return NextResponse.json({ error: "Invalid path" }, { status: 400 });
		return NextResponse.json(out);
	}

	// Text scratch.
	const body: { ext?: string; content?: string } = await request
		.json()
		.catch(() => ({}) as { ext?: string; content?: string });
	if (typeof body.content !== "string") {
		return NextResponse.json({ error: "Missing content" }, { status: 400 });
	}
	if (Buffer.byteLength(body.content, "utf8") > SCRATCH_MAX_BYTES) {
		return NextResponse.json({ error: "Content too large" }, { status: 413 });
	}
	const ext = sanitizeExt(body.ext);
	const out = await writeScratch(rootDir, ext, body.content);
	if (!out)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	return NextResponse.json(out);
}
