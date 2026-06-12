import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

const ALLOWED_MIME_TYPES = new Set([
	"application/pdf",
	"text/plain",
	"text/markdown",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"application/octet-stream",
]);

const ALLOWED_EXTENSIONS = new Set([
	"pdf", "txt", "md", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"jpg", "jpeg", "png", "gif", "webp", "svg", "csv", "json",
	"yaml", "yml", "xml", "html", "sh", "mp4", "webm", "mov",
	"mp3", "wav", "ogg", "m4a", "aac", "ipynb", "mmd",
]);

const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function sanitizeFilename(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
	}

	const file = formData.get("file");
	if (!file || !(file instanceof File))
		return NextResponse.json({ error: "No file provided" }, { status: 400 });

	const dir = (formData.get("dir") as string) ?? "";
	const targetDir = safeWorkspacePath(rootDir, dir);
	if (!targetDir)
		return NextResponse.json({ error: "Invalid directory" }, { status: 400 });

	const fileExt = file.name.split(".").pop()?.toLowerCase() ?? "";
	if (!ALLOWED_MIME_TYPES.has(file.type) && !ALLOWED_EXTENSIONS.has(fileExt)) {
		return NextResponse.json(
			{ error: `File type not allowed: ${file.name}` },
			{ status: 400 },
		);
	}

	if (file.size > MAX_SIZE_BYTES) {
		return NextResponse.json(
			{ error: "File exceeds 100MB limit" },
			{ status: 400 },
		);
	}

	const baseName = sanitizeFilename(file.name.replace(/\.[^.]+$/, ""));
	const savedFilename = `${baseName}.${fileExt}`;
	const filePath = path.join(targetDir, savedFilename);

	try {
		await mkdir(targetDir, { recursive: true });
		const buffer = Buffer.from(await file.arrayBuffer());
		await writeFile(filePath, buffer);
	} catch {
		return NextResponse.json({ error: "Failed to save file" }, { status: 500 });
	}

	const relPath = dir ? `${dir}/${savedFilename}` : savedFilename;
	return NextResponse.json({
		filename: savedFilename,
		path: relPath,
		originalName: file.name,
	});
}
