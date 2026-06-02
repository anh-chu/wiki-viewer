/**
 * GET /api/system/auth-config — public, unauthenticated.
 *
 * The sign-in page renders before any session exists, so it needs a public way
 * to learn which auth methods are available: whether email/password is enabled
 * and whether a social provider (Google) is configured. No secrets are exposed,
 * only booleans describing which UI to show.
 */
import { NextResponse } from "next/server";
import { passwordAuthEnabled } from "@/lib/auth/server";

export const runtime = "nodejs";

export function GET() {
	const google = Boolean(
		process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
	);
	return NextResponse.json({
		passwordAuth: passwordAuthEnabled,
		google,
	});
}
