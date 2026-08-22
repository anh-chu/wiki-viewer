import { NextResponse } from "next/server";
import path from "node:path";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";

import { checkAndConsume } from "@/lib/proof/rate-limit";
import {
	getShareByToken,
	verifyPassword,
	revokeShare,
	incrementViewCount,
	isExpired,
} from "@/lib/shared-docs/db";
import { resolveShareTarget } from "@/lib/shared-docs/share-target";
import {
	isUnlocked,
	serializeUnlockCookie,
} from "@/lib/shared-docs/access-grant";

const MAX_DISPLAY_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_CANVAS_DISPLAY_SIZE = 10 * 1024 * 1024; // 10MB
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

async function readShareContent(absPath: string): Promise<string | null> {
	const { readFile, stat } = await import("node:fs/promises");
	try {
		const info = await stat(absPath);
		const maxSize = path.extname(absPath).toLowerCase() === ".excalidraw"
			? MAX_CANVAS_DISPLAY_SIZE
			: MAX_DISPLAY_SIZE;
		if (info.size > maxSize) return null;
		const buffer = await readFile(absPath);
		return buffer.toString("utf-8");
	} catch (err: unknown) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error("[share] readFile(%s) %s", absPath, detail);
		return null;
	}
}

// ── GET: Resolve a share link (public) ───────────────────────────────────────

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const rl = checkAndConsume(`share:${token}`, 1);
	if (!rl.ok) {
		return NextResponse.json(
			{ error: "rate_limited", message: "Too many requests" },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
			},
		);
	}

	const share = getShareByToken(token);
	if (!share) {
		return NextResponse.json(
			{ error: "not_found", message: "Share link not found" },
			{ status: 404, headers: PRIVATE_NO_STORE },
		);
	}
	if (share.isRevoked) {
		return NextResponse.json(
			{ error: "revoked", message: "Share link has been revoked" },
			{ status: 410, headers: PRIVATE_NO_STORE },
		);
	}
	if (isExpired(share)) {
		return NextResponse.json(
			{ error: "expired", message: "Share link has expired" },
			{ status: 410, headers: PRIVATE_NO_STORE },
		);
	}

	if (share.passwordHash && !isUnlocked(request, token, share.passwordHash)) {
		return NextResponse.json(
			{ protected: true, message: "This document is password-protected" },
			{ status: 401, headers: PRIVATE_NO_STORE },
		);
	}

	const resolved = await resolveShareTarget(token);
	if (!resolved.ok) return resolved.response;

	const content = await readShareContent(resolved.target.absPath);
	if (content === null) {
		return NextResponse.json(
			{ error: "read_error", message: "Failed to read file" },
			{ status: 500, headers: PRIVATE_NO_STORE },
		);
	}

	incrementViewCount(token);

	return NextResponse.json(
		{
			content,
			filename: resolved.target.filename,
			filePath: resolved.target.share.filePath,
			viewCount: resolved.target.share.viewCount + 1,
		},
		{ headers: share.passwordHash ? PRIVATE_NO_STORE : undefined },
	);
}

// ── POST: Unlock a password-protected share ───────────────────────────────────

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const share = getShareByToken(token);
	if (!share) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}
	if (share.isRevoked) {
		return NextResponse.json({ error: "revoked" }, { status: 410 });
	}
	if (isExpired(share)) {
		return NextResponse.json({ error: "expired" }, { status: 410 });
	}
	if (!share.passwordHash) {
		return NextResponse.json({ error: "not_protected" }, { status: 400 });
	}

	const rl = checkAndConsume(`share-pwd:${token}`, 1);
	if (!rl.ok) {
		return NextResponse.json(
			{ error: "rate_limited", message: "Too many attempts. Try again later." },
			{
				status: 429,
				headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
			},
		);
	}

	const body: { password?: string } = await request.json();
	if (!body.password || typeof body.password !== "string") {
		return NextResponse.json({ error: "missing_password" }, { status: 400 });
	}

	if (!verifyPassword(body.password, share.passwordHash)) {
		return NextResponse.json(
			{ error: "wrong_password", message: "Incorrect password" },
			{ status: 403, headers: PRIVATE_NO_STORE },
		);
	}

	const resolved = await resolveShareTarget(token);
	if (!resolved.ok) return resolved.response;

	const content = await readShareContent(resolved.target.absPath);
	if (content === null) {
		return NextResponse.json(
			{ error: "read_error", message: "Failed to read file" },
			{ status: 500, headers: PRIVATE_NO_STORE },
		);
	}

	incrementViewCount(token);

	const setCookie = serializeUnlockCookie(request, token, share.passwordHash);
	return NextResponse.json(
		{
			content,
			filename: resolved.target.filename,
			filePath: resolved.target.share.filePath,
			viewCount: resolved.target.share.viewCount + 1,
		},
		{
			headers: {
				...PRIVATE_NO_STORE,
				"Set-Cookie": setCookie,
			},
		},
	);
}

// ── DELETE: Revoke a share link (auth required) ───────────────────────────────

export async function DELETE(
	request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	const { token } = await params;

	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const auth = await requireUser(request);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const share = getShareByToken(token);
	if (!share) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	if (share.createdBy !== auth.user.id) {
		const { isAdmin } = await import("@/lib/auth/admin");
		const admin = await isAdmin(auth.user.id, auth.user.email);
		if (!admin) {
			return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
		}
	}

	revokeShare(share.id);

	return NextResponse.json({ ok: true });
}
