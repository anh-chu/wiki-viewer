import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getShareByToken, isExpired, verifyPassword, incrementViewCount } from "@/lib/shared-docs/db";
import { getWorkspace } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import { checkAndConsume } from "@/lib/proof/rate-limit";

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

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10MB for binary assets

/**
 * GET /api/share/[token]/asset — serve the raw file bytes for a public share.
 * Used for images, PDFs, and media that cannot be served as UTF-8 text.
 * Accepts an optional `password` query parameter for password-protected shares.
 */
export async function GET(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const rl = checkAndConsume(`share-asset:${token}`, 1);
	if (!rl.ok) {
		return NextResponse.json(
			{ error: "rate_limited" },
			{ status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } },
		);
	}

	const share = getShareByToken(token);
	if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });
	if (share.isRevoked) return NextResponse.json({ error: "revoked" }, { status: 410 });
	if (isExpired(share)) return NextResponse.json({ error: "expired" }, { status: 410 });

	// Password-protected shares require the password as a query param
	if (share.passwordHash) {
		const { searchParams } = new URL(request.url);
		const pwd = searchParams.get("password");
		if (!pwd || !verifyPassword(pwd, share.passwordHash)) {
			return NextResponse.json({ error: "unauthorized" }, { status: 401 });
		}
	}

	const ws = await getWorkspace(share.workspaceId);
	if (!ws) return NextResponse.json({ error: "workspace_gone" }, { status: 410 });

	const absPath = await safeAbsPath(ws.rootDir, share.filePath);
	if (!absPath) return NextResponse.json({ error: "path_invalid" }, { status: 400 });

	try {
		const info = await stat(absPath);
		if (info.size > MAX_ASSET_SIZE) {
			return NextResponse.json({ error: "too_large" }, { status: 413 });
		}
	} catch {
		return NextResponse.json({ error: "file_gone" }, { status: 410 });
	}

	const buffer = await readFile(absPath);
	const ext = path.extname(share.filePath).slice(1).toLowerCase();
	const mime = MIME_MAP[ext] ?? "application/octet-stream";
	const filename = path.basename(share.filePath);

	incrementViewCount(token);

	return new NextResponse(buffer, {
		headers: {
			"Content-Type": mime,
			"Content-Disposition": `inline; filename="${filename}"`,
			"Cache-Control": "public, max-age=300",
		},
	});
}
