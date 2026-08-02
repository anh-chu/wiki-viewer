import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { checkAndConsume } from "@/lib/proof/rate-limit";
import { mimeByExt } from "@/lib/proof/raw-fs";
import { resolveShareTarget } from "@/lib/shared-docs/share-target";
import {
	isUnlocked,
	inlineContentDisposition,
} from "@/lib/shared-docs/access-grant";
import { incrementViewCount } from "@/lib/shared-docs/db";

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10MB

// ── GET: Serve raw file bytes for a public share ─────────────────────────────

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const rl = checkAndConsume(`share-asset:${token}`, 1);
	if (!rl.ok) {
		return NextResponse.json(
			{ error: "rate_limited" },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
			},
		);
	}

	const resolved = await resolveShareTarget(token);
	if (!resolved.ok) return resolved.response;
	const { share, absPath, filename } = resolved.target;

	if (share.passwordHash && !isUnlocked(request, token, share.passwordHash)) {
		return NextResponse.json(
			{ error: "unauthorized", message: "Unlock required" },
			{
				status: 401,
				headers: { "Cache-Control": "private, no-store" },
			},
		);
	}

	let info;
	try {
		info = await stat(absPath);
	} catch {
		return NextResponse.json(
			{ error: "file_gone" },
			{ status: 410, headers: { "Cache-Control": "private, no-store" } },
		);
	}
	if (info.size > MAX_ASSET_SIZE) {
		return NextResponse.json(
			{ error: "too_large" },
			{ status: 413, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const buffer = await readFile(absPath);
	const mime = mimeByExt(absPath);

	incrementViewCount(token);

	const isProtected = !!share.passwordHash;
	return new NextResponse(buffer, {
		headers: {
			"Content-Type": mime,
			"Content-Disposition": inlineContentDisposition(filename),
			"Cache-Control": isProtected
				? "private, no-store"
				: "public, max-age=300",
		},
	});
}
