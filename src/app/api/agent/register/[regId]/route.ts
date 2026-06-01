/**
 * GET /api/agent/register/:regId
 *
 * Poll registration status. No auth required — regId acts as secret.
 *
 * Responses:
 *   202 { status: "pending" }
 *   200 { status: "approved", agentId, token }  — one-shot pickup, deletes token
 *   410 { status: "consumed" | "denied" }
 *   404 { status: "not_found" }
 */
import { NextResponse } from "next/server";
import { getRegistration, consumeRegistration } from "@/lib/proof/pending";

export const runtime = "nodejs";

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ regId: string }> },
): Promise<NextResponse> {
	const { regId } = await params;
	const reg = getRegistration(regId);

	if (!reg) {
		return NextResponse.json({ status: "not_found" }, { status: 404 });
	}

	switch (reg.status) {
		case "pending":
			return NextResponse.json({ status: "pending" }, { status: 202 });

		case "approved": {
			const token = consumeRegistration(regId);
			if (!token) {
				// Already consumed between the get and consume (race) — treat as consumed
				return NextResponse.json({ status: "consumed" }, { status: 410 });
			}
			return NextResponse.json(
				{ status: "approved", agentId: reg.agentId, token },
				{ status: 200 },
			);
		}

		case "consumed":
			return NextResponse.json({ status: "consumed" }, { status: 410 });

		case "denied":
			return NextResponse.json({ status: "denied" }, { status: 410 });
	}
}
