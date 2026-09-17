/**
 * GET  /api/system/service-token — return the current service token.
 * POST /api/system/service-token — rotate (regenerate) the token.
 *
 * Requires authentication. The token is stored at ~/.wiki-viewer/service-token
 * and is used by automated MCP clients to bootstrap agent registration
 * (POST /api/agent/register with X-Service-Token) without human approval.
 *
 * Its only power is minting scoped agent tokens; it grants no direct API access.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { getServiceToken, rotateServiceToken } from "@/lib/auth/service-token";

export const runtime = "nodejs";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	return NextResponse.json({ key: getServiceToken() });
}

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const key = rotateServiceToken();
	return NextResponse.json({ key });
}
