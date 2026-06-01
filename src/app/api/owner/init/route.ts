/**
 * GET /api/owner/init
 *
 * Legacy bootstrap endpoint. Now redirects to /signin (Better Auth).
 * Kept for back-compat — any agent or UI calling this will be redirected.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET(req: Request): NextResponse {
	const url = new URL("/signin", req.url);
	return NextResponse.redirect(url, { status: 308 });
}
