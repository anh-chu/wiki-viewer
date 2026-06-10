import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeAbsPath } from "@/lib/proof/raw-fs";
import {
	createShare,
	listSharesForFile,
} from "@/lib/shared-docs/db";

// ── POST: Create a share link ─────────────────────────────────────────────────

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	// Must be signed in
	const auth = await requireUser(request);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}

	const body: {
		path?: string;
		password?: string;
		expiresAt?: string;
	} = await request.json();

	const relPath = body.path;
	if (!relPath || typeof relPath !== "string") {
		return NextResponse.json({ error: "Missing path" }, { status: 400 });
	}

	// Verify the file exists and belongs to this workspace
	const absPath = await safeAbsPath(ctx.rootDir, relPath);
	if (!absPath) {
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	}

	const { stat } = await import("node:fs/promises");
	try {
		await stat(absPath);
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}

	// Validate optional params
	if (body.password !== undefined && typeof body.password !== "string") {
		return NextResponse.json({ error: "Invalid password" }, { status: 400 });
	}
	if (
		body.expiresAt !== undefined &&
		body.expiresAt !== null &&
		typeof body.expiresAt !== "string"
	) {
		return NextResponse.json({ error: "Invalid expiresAt" }, { status: 400 });
	}
	// Reject invalid or already-expired dates
	if (body.expiresAt) {
		const d = new Date(body.expiresAt);
		if (isNaN(d.getTime())) {
			return NextResponse.json({ error: "Invalid date" }, { status: 400 });
		}
		if (d.getTime() < Date.now()) {
			return NextResponse.json({ error: "Date is in the past" }, { status: 400 });
		}
	}

	const share = createShare({
		workspaceId: ctx.ws.id,
		filePath: relPath,
		password: body.password && body.password.length > 0 ? body.password : undefined,
		expiresAt: body.expiresAt || undefined,
		createdBy: auth.user.id,
	});

	return NextResponse.json({
		token: share.token,
		url: `/s/${share.token}`,
		hasPassword: !!share.passwordHash,
		expiresAt: share.expiresAt,
		createdAt: share.createdAt,
	});
}

// ── GET: List share links for a file ──────────────────────────────────────────

export async function GET(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const auth = await requireUser(request);
	if (!auth.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) {
		return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	}

	const { searchParams } = new URL(request.url);
	const relPath = searchParams.get("path");
	if (!relPath) {
		return NextResponse.json({ error: "Missing path" }, { status: 400 });
	}

	const shares = listSharesForFile(ctx.ws.id, relPath);

	return NextResponse.json({
		shares: shares.map((s) => ({
			id: s.id,
			token: s.token,
			url: `/s/${s.token}`,
			hasPassword: !!s.passwordHash,
			expiresAt: s.expiresAt,
			createdAt: s.createdAt,
			viewCount: s.viewCount,
			isExpired: s.expiresAt ? new Date(s.expiresAt) < new Date() : false,
		})),
	});
}
