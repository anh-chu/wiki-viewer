/**
 * POST /api/system/users  (admin only)
 *
 * Admin creates a new account with a generated temporary password, returned
 * once in the response. The new user signs in and changes it. The signup
 * allowlist is bypassed for admin-initiated creation (the admin is the gate).
 *
 * This calls auth.api.signUpEmail server-side; the session it would mint for
 * the new user is discarded (we never forward those Set-Cookie headers), so
 * the admin's own session is untouched.
 */
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireAdmin } from "@/lib/auth/admin";
import { auth, authReady, withAdminUserCreate, passwordAuthEnabled, db } from "@/lib/auth/server";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Readable temp password: 4 groups, mixed case + digits, no ambiguous chars. */
function generateTempPassword(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	const bytes = randomBytes(16);
	let out = "";
	for (let i = 0; i < 16; i++) {
		out += alphabet[bytes[i] % alphabet.length];
		if (i % 4 === 3 && i < 15) out += "-";
	}
	return out; // e.g. "k7Pm-9QrT-x2Vn-bL4w"
}

export async function POST(req: Request): Promise<NextResponse> {
	const csrf = checkOrigin(req);
	if (csrf) return csrf;

	const admin = await requireAdmin(req);
	if (!admin.ok) {
		return NextResponse.json({ error: admin.code }, { status: admin.status });
	}

	if (!passwordAuthEnabled) {
		return NextResponse.json(
			{ error: "PASSWORD_AUTH_DISABLED", message: "Email/password sign-in is disabled; cannot create password accounts." },
			{ status: 400 },
		);
	}

	let body: { email?: unknown; name?: unknown };
	try {
		body = (await req.json()) as { email?: unknown; name?: unknown };
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Invalid JSON" }, { status: 400 });
	}

	const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
	const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : email.split("@")[0];

	if (!EMAIL_RE.test(email)) {
		return NextResponse.json({ error: "INVALID_EMAIL", message: "A valid email is required" }, { status: 400 });
	}

	const tempPassword = generateTempPassword();

	await authReady();
	// Reject duplicates up front (signUpEmail may otherwise create a second
	// credential row or silently succeed depending on Better Auth internals).
	try {
		const existing = db
			.prepare("SELECT 1 FROM user WHERE lower(email) = ? LIMIT 1")
			.get(email);
		if (existing) {
			return NextResponse.json(
				{ error: "USER_EXISTS", message: "A user with that email already exists." },
				{ status: 409 },
			);
		}
	} catch {
		// If the lookup fails, fall through and let signUpEmail decide.
	}

	try {
		// Bypass the signup allowlist for this admin-initiated creation. The
		// returned response (and any session cookie) is intentionally discarded.
		const result = await withAdminUserCreate(() =>
			auth.api.signUpEmail({
				body: { email, password: tempPassword, name },
				asResponse: true,
			}),
		);
		if (!result.ok) {
			const text = await result.text().catch(() => "");
			if (/exist|unique|already/i.test(text)) {
				return NextResponse.json(
					{ error: "USER_EXISTS", message: "A user with that email already exists." },
					{ status: 409 },
				);
			}
			return NextResponse.json(
				{ error: "CREATE_FAILED", message: text || "Failed to create user" },
				{ status: 500 },
			);
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : "";
		if (/exist|unique|already/i.test(msg)) {
			return NextResponse.json(
				{ error: "USER_EXISTS", message: "A user with that email already exists." },
				{ status: 409 },
			);
		}
		return NextResponse.json(
			{ error: "CREATE_FAILED", message: msg || "Failed to create user" },
			{ status: 500 },
		);
	}

	return NextResponse.json({ ok: true, email, name, tempPassword });
}
