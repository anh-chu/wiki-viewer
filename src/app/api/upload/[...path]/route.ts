import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DENIED_SEGMENTS = [".proof", ".git"];

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
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const wsx = await resolveWorkspaceForUser(request, "write");
	if (!wsx.ok) return NextResponse.json({ error: wsx.code }, { status: wsx.status });
	const { rootDir } = wsx;

	const { path: segments } = await params;
	const subPath = (segments ?? []).join("/");

	// Validate the requested page path itself before deriving the co-located
	// assets folder.  This catches symlink escapes such as a page path that is
	// itself a symlink pointing outside the workspace.
	const pageResolved = await resolveWorkspacePath(rootDir, subPath, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!pageResolved) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	// Co-locate uploads in an `assets/` subfolder next to the page so the stored
	// markdown path is portable: docs/notes.md -> docs/assets/<file> -> ./assets/<file>
	const pageDir = path.posix.dirname(subPath);
	const baseRel = pageDir && pageDir !== "." ? `${pageDir}/assets` : "assets";

	const resolved = await resolveWorkspacePath(rootDir, baseRel, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!resolved)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const uploadsDir = resolved.absolutePath;

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

		const relParts = baseRel.split("/").concat(finalName).filter(Boolean);
		const relUrl = relParts.map(encodeURIComponent).join("/");
		const relPath = relParts.join("/");
		return NextResponse.json({
			url: `/api/assets/${relUrl}`,
			path: relPath,
			size: bytes.length,
			mimeType: file.type || "application/octet-stream",
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "Write failed";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
