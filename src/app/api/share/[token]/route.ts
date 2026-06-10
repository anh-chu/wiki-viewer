import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { getWorkspace } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import { checkAndConsume } from "@/lib/proof/rate-limit";
import {
	getShareByToken,
	verifyPassword,
	revokeShare,
	isExpired,
	incrementViewCount,
} from "@/lib/shared-docs/db";

const MAX_DISPLAY_SIZE = 1 * 1024 * 1024; // 1MB

// ── Shared helper: read file content for a resolved share ────────────────────

async function resolveContent(
	token: string,
): Promise<
	| { ok: true; content: string; filename: string; viewCount: number }
	| { ok: false; response: NextResponse }
> {
	const share = getShareByToken(token);
	if (!share) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "not_found", message: "Share link not found" },
				{ status: 404 },
			),
		};
	}

	if (share.isRevoked) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "revoked", message: "Share link has been revoked" },
				{ status: 410 },
			),
		};
	}

	if (isExpired(share)) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "expired", message: "Share link has expired" },
				{ status: 410 },
			),
		};
	}

	const ws = await getWorkspace(share.workspaceId);
	if (!ws) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "workspace_gone", message: "Workspace no longer exists" },
				{ status: 410 },
			),
		};
	}

	const absPath = await safeAbsPath(ws.rootDir, share.filePath);
	if (!absPath) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "path_invalid", message: "Invalid file path" },
				{ status: 400 },
			),
		};
	}

	const { readFile, stat } = await import("node:fs/promises");
	try {
		const info = await stat(absPath);
		if (info.size > MAX_DISPLAY_SIZE) {
			return {
				ok: false,
				response: NextResponse.json(
					{ error: "too_large", message: "File too large to share (max 1MB)" },
					{ status: 413 },
				),
			};
		}
	} catch {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "file_gone", message: "File no longer exists" },
				{ status: 410 },
			),
		};
	}

	let content: string;
	try {
		const buffer = await readFile(absPath);
		content = buffer.toString("utf-8");
	} catch (err: unknown) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error("[share] readFile(%s) %s", absPath, detail);
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "read_error", message: "Failed to read file" },
				{ status: 500 },
			),
		};
	}

	incrementViewCount(token);
	const filename = share.filePath.split("/").pop() ?? share.filePath;

	return { ok: true, content, filename, viewCount: share.viewCount + 1 };
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
			{ status: 404 },
		);
	}

	if (share.isRevoked) {
		return NextResponse.json(
			{ error: "revoked", message: "Share link has been revoked" },
			{ status: 410 },
		);
	}

	if (isExpired(share)) {
		return NextResponse.json(
			{ error: "expired", message: "Share link has expired" },
			{ status: 410 },
		);
	}

	// Password-protected: tell client to POST to /unlock instead
	if (share.passwordHash) {
		return NextResponse.json(
			{ protected: true, message: "This document is password-protected" },
			{ status: 401 },
		);
	}

	const result = await resolveContent(token);
	if (!result.ok) return result.response;

	return NextResponse.json({
		content: result.content,
		filename: result.filename,
		viewCount: result.viewCount,
	});
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

	// Rate limit password attempts
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
			{ status: 403 },
		);
	}

	const result = await resolveContent(token);
	if (!result.ok) return result.response;

	return NextResponse.json({
		content: result.content,
		filename: result.filename,
		viewCount: result.viewCount,
	});
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
