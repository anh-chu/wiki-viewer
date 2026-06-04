import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveWorkspaceForAgent } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function sanitizeFilename(name: string): string {
	const lowered = name.toLowerCase();
	const cleaned = lowered.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
	const trimmed = cleaned.replace(/^[-.]+/, "").replace(/-+$/, "");
	return trimmed || "file";
}

async function pickAvailableName(dir: string, filename: string): Promise<string> {
	const ext = path.extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	let candidate = filename;
	let n = 2;
	while (true) {
		try {
			await stat(path.join(dir, candidate));
			candidate = `${stem}-${n}${ext}`;
			n += 1;
		} catch {
			return candidate;
		}
	}
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
) {
	const wsx = await resolveWorkspaceForAgent(request);
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const { path: segments } = await params;
	const subPath = (segments ?? []).join("/");

	// Save images in _uploads/ within rootDir, mirroring the page path
	const uploadsDir = path.join(rootDir, "_uploads", subPath);
	const resolved = safeWorkspacePath(rootDir, path.join("_uploads", subPath));
	if (!resolved)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
	}

	const file = form.get("file");
	if (!(file instanceof File))
		return NextResponse.json({ error: "Missing file field" }, { status: 400 });
	if (file.size > MAX_UPLOAD_BYTES)
		return NextResponse.json({ error: "File exceeds 50MB limit" }, { status: 413 });

	const filename = sanitizeFilename(file.name || "file");

	try {
		await mkdir(uploadsDir, { recursive: true });
		const finalName = await pickAvailableName(uploadsDir, filename);
		const targetPath = path.join(uploadsDir, finalName);
		const bytes = Buffer.from(await file.arrayBuffer());
		await writeFile(targetPath, bytes);

		const relParts = ["_uploads", subPath, finalName].filter(Boolean);
		const relUrl = relParts.map(encodeURIComponent).join("/");
		const relPath = relParts.join("/");
		return NextResponse.json({
			url: `/api/assets/${relUrl}`,
			path: relPath,
			absolutePath: targetPath,
			size: bytes.length,
			mimeType: file.type || "application/octet-stream",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Write failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
