/**
 * GET  /api/system/api-key — return the current embed API key.
 * POST /api/system/api-key — rotate (regenerate) the key.
 *
 * Requires authentication. The key is stored at ~/.wiki-viewer/api-key
 * and is used by external tools (e.g. termyard) to authenticate against
 * the embed iframe and API endpoints.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { getApiKey, rotateApiKey } from "@/lib/auth/api-key";

export const runtime = "nodejs";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	return NextResponse.json({ key: getApiKey() });
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const key = rotateApiKey();
	return NextResponse.json({ key });
}
