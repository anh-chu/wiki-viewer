import { NextResponse } from "next/server";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { checkAndConsume } from "@/lib/proof/rate-limit";
import { mimeByExt } from "@/lib/proof/raw-fs";
import { resolveShareRoot, resolveInShare } from "@/lib/shared-docs/share-target";
import {
	isUnlocked,
	inlineContentDisposition,
} from "@/lib/shared-docs/access-grant";
import { incrementViewCount } from "@/lib/shared-docs/db";

const MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10MB

// One folder page can load many images and other files, so asset requests need
// a far larger allowance than the 60/min default. The bucket keeps the size it
// is first created with, so every caller for this key must pass the same value.
const ASSET_BUCKET = 600;

// ── GET: Serve raw file bytes for a public share ─────────────────────────────

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const rl = checkAndConsume(`share-asset:${token}`, 1, ASSET_BUCKET);
	if (!rl.ok) {
		return NextResponse.json(
			{ error: "rate_limited" },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
			},
		);
	}

	const rel = new URL(request.url).searchParams.get("path") ?? "";

	const resolved = await resolveShareRoot(token);
	if (!resolved.ok) return resolved.response;
	const { share, realRoot } = resolved.target;

	if (share.passwordHash && !isUnlocked(request, token, share.passwordHash)) {
		return NextResponse.json(
			{ error: "unauthorized", message: "Unlock required" },
			{
				status: 401,
				headers: { "Cache-Control": "private, no-store" },
			},
		);
	}

	// A file share serves exactly one file, at its root.
	if (share.kind === "file" && rel !== "") {
		return NextResponse.json(
			{ error: "path_invalid", message: "Invalid path" },
			{ status: 400, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const target = await resolveInShare(realRoot, rel);
	if (!target) {
		return NextResponse.json(
			{ error: "path_invalid", message: "Invalid path" },
			{ status: 400, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	let info;
	try {
		info = await stat(target.absolutePath);
	} catch {
		return NextResponse.json(
			{ error: "file_gone" },
			{ status: 410, headers: { "Cache-Control": "private, no-store" } },
		);
	}
	if (info.isDirectory()) {
		return NextResponse.json(
			{ error: "path_invalid", message: "Invalid path" },
			{ status: 400, headers: { "Cache-Control": "private, no-store" } },
		);
	}
	if (info.size > MAX_ASSET_SIZE) {
		return NextResponse.json(
			{ error: "too_large" },
			{ status: 413, headers: { "Cache-Control": "private, no-store" } },
		);
	}

	const buffer = await readFile(target.absolutePath);
	const mime = mimeByExt(target.absolutePath);
	const filename = path.basename(target.absolutePath);

	// Only a root view counts. A folder page may request dozens of assets.
	if (rel === "") incrementViewCount(token);

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
