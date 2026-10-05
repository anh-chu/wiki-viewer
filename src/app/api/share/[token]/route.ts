import { NextResponse } from "next/server";
import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";

import { checkAndConsume } from "@/lib/proof/rate-limit";
import {
	getShareByToken,
	verifyPassword,
	revokeShare,
	incrementViewCount,
	isExpired,
	type SharedDoc,
} from "@/lib/shared-docs/db";
import { resolveShareRoot, resolveInShare } from "@/lib/shared-docs/share-target";
import {
	isUnlocked,
	serializeUnlockCookie,
} from "@/lib/shared-docs/access-grant";

const MAX_DISPLAY_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_CANVAS_DISPLAY_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LIST_ENTRIES = 2000;
const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

interface ShareEntry {
	name: string;
	/** Path relative to the share root, so no ancestor path ever leaves here. */
	path: string;
	isDir: boolean;
	size: number;
}

async function readShareContent(absPath: string): Promise<string | null> {
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

/**
 * List one level of a shared folder. Names a visitor can never open — hidden
 * names, symlinks that leave the share, denied segments — are omitted, so the
 * listing can never advertise something the content route would refuse.
 */
async function listShareDir(
	realRoot: string,
	rel: string,
	absDir: string,
): Promise<{ entries: ShareEntry[]; truncated: boolean }> {
	const dirents = await readdir(absDir, { withFileTypes: true });
	const entries: ShareEntry[] = [];

	for (const dirent of dirents) {
		if (dirent.name.startsWith(".")) continue;
		const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
		const child = await resolveInShare(realRoot, childRel);
		if (!child) continue;
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(child.absolutePath);
		} catch {
			continue;
		}
		const isDir = info.isDirectory();
		if (!isDir && !info.isFile()) continue;
		entries.push({
			name: dirent.name,
			path: childRel,
			isDir,
			size: isDir ? 0 : info.size,
		});
	}

	entries.sort((a, b) =>
		a.isDir === b.isDir
			? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
			: a.isDir
				? -1
				: 1,
	);

	const truncated = entries.length > MAX_LIST_ENTRIES;
	return { entries: truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries, truncated };
}

/**
 * Build the response for a share view: a folder listing, or a file's content.
 * `rel` is relative to the share root. The view count moves only for a root
 * view, so one page of images does not count as one view per image.
 */
async function buildShareView(
	share: SharedDoc,
	token: string,
	rel: string,
): Promise<NextResponse> {
	const resolved = await resolveShareRoot(token);
	if (!resolved.ok) return resolved.response;
	const { realRoot, absPath: shareRootPath } = resolved.target;
	// The share root's own name labels the listing at every depth, so a visitor
	// always sees where the share starts.
	const rootName = path.basename(shareRootPath);

	// A file share has exactly one readable path: its root.
	if (share.kind === "file" && rel !== "") {
		return NextResponse.json(
			{ error: "path_invalid", message: "Invalid path" },
			{ status: 400, headers: PRIVATE_NO_STORE },
		);
	}

	const target = await resolveInShare(realRoot, rel);
	if (!target) {
		return NextResponse.json(
			{ error: "path_invalid", message: "Invalid path" },
			{ status: 400, headers: PRIVATE_NO_STORE },
		);
	}

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(target.absolutePath);
	} catch {
		return NextResponse.json(
			{ error: "file_gone", message: "File no longer exists" },
			{ status: 410, headers: PRIVATE_NO_STORE },
		);
	}

	const isRootView = rel === "";
	if (isRootView) incrementViewCount(token);
	const viewCount = share.viewCount + (isRootView ? 1 : 0);
	const headers = share.passwordHash ? PRIVATE_NO_STORE : undefined;

	if (info.isDirectory()) {
		if (share.kind !== "dir") {
			return NextResponse.json(
				{ error: "path_invalid", message: "Directories cannot be shared" },
				{ status: 400, headers: PRIVATE_NO_STORE },
			);
		}
		const { entries, truncated } = await listShareDir(realRoot, rel, target.absolutePath);
		return NextResponse.json(
			{
				kind: "dir",
				shareKind: share.kind,
				shareName: rootName,
				name: rootName,
				path: rel,
				entries,
				truncated,
				viewCount,
			},
			{ headers },
		);
	}

	const content = await readShareContent(target.absolutePath);
	if (content === null) {
		return NextResponse.json(
			{ error: "read_error", message: "Failed to read file" },
			{ status: 500, headers: PRIVATE_NO_STORE },
		);
	}

	return NextResponse.json(
		{
			kind: "file",
			// The share's own kind, not this view's: a file share and a folder
			// share can both serve a file, and the client needs to know which it
			// is to decide whether to render navigation.
			shareKind: share.kind,
			// The share root's name, so navigation can label itself even when the
			// reader is showing a nested file.
			shareName: rootName,
			content,
			filename: path.basename(target.absolutePath),
			path: rel,
			// File shares keep the workspace-relative path they always reported;
			// a folder share reports the path inside the share instead, so no
			// path above the share root is ever disclosed.
			filePath: share.kind === "file" ? share.filePath : rel,
			viewCount,
		},
		{ headers },
	);
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

	const rel = new URL(request.url).searchParams.get("path") ?? "";
	return buildShareView(share, token, rel);
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

	const rel = new URL(request.url).searchParams.get("path") ?? "";
	const view = await buildShareView(share, token, rel);
	if (!view.ok) return view;

	const setCookie = serializeUnlockCookie(request, token, share.passwordHash);
	view.headers.set("Set-Cookie", setCookie);
	view.headers.set("Cache-Control", "private, no-store");
	return view;
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
