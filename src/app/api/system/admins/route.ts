/**
 * Admin management API.
 *
 * GET  /api/system/admins  — any signed-in user (returns isAdmin flag, admin list,
 *                            and user roster if caller is admin).
 * POST   { userId }        — admin-only: promote user to admin.
 * DELETE { userId }        — admin-only: demote user; refuses to remove last admin.
 *
 * Bootstrap: first authenticated request triggers ensureBootstrapAdmin so the
 * first user to sign in becomes admin when no WIKI_ADMIN_EMAILS is set.
 */
import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import {
	isAdmin,
	listAdmins,
	addAdmin,
	removeAdmin,
	requireAdmin,
	ensureBootstrapAdmin,
} from "@/lib/auth/admin";

export const runtime = "nodejs";

interface UserRow {
	id: string;
	email: string;
	name: string;
}

function queryAllUsers(): UserRow[] {
	try {
		const dir = path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
		mkdirSync(dir, { recursive: true });
		const db = new Database(path.join(dir, "auth.db"));
		db.pragma("journal_mode = WAL");
		return db.prepare("SELECT id, email, name FROM user").all() as UserRow[];
	} catch {
		return [];
	}
}

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	// Bootstrap: first authenticated user becomes admin if no admin set yet.
	await ensureBootstrapAdmin(auth.user.id);

	const admin = await isAdmin(auth.user.id, auth.user.email);
	const admins = await listAdmins();
	const users = admin ? queryAllUsers() : [];

	return NextResponse.json({ admins, isAdmin: admin, users });
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const body: { userId?: string } = await request.json();
	if (!body.userId?.trim())
		return NextResponse.json({ error: "Missing userId" }, { status: 400 });

	await addAdmin(body.userId.trim());
	const admins = await listAdmins();
	return NextResponse.json({ ok: true, admins });
}

export async function DELETE(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const authResult = await requireAdmin(request);
	if (!authResult.ok)
		return NextResponse.json({ error: authResult.code }, { status: authResult.status });

	const body: { userId?: string } = await request.json();
	if (!body.userId?.trim())
		return NextResponse.json({ error: "Missing userId" }, { status: 400 });

	try {
		await removeAdmin(body.userId.trim());
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (msg.startsWith("LAST_ADMIN")) {
			return NextResponse.json({ error: "LAST_ADMIN", message: msg }, { status: 409 });
		}
		throw e;
	}

	const admins = await listAdmins();
	return NextResponse.json({ ok: true, admins });
}
