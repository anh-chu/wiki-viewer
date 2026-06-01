/**
 * Token regeneration — deprecated and removed.
 *
 * Auth is now managed via TOFU registration flow. Use the AI Panel or
 * /api/agent/admin/* endpoints to manage agents.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(_req: Request): Promise<NextResponse> {
	return NextResponse.json(
		{
			error: "GONE",
			message:
				"Token regeneration is deprecated. Manage agents via /api/agent/admin/* or the AI Panel.",
		},
		{ status: 410 },
	);
}
