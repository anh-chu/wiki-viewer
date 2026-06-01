/**
 * GET /api/agent/admin/registrations
 *
 * List pending registrations. Requires authenticated user session.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { listPendingRegistrations } from "@/lib/proof/pending";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
	const owner = await requireUser(req);
	if (!owner.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const pending = listPendingRegistrations().map((r) => ({
		registrationId: r.registrationId,
		agentId: r.agentId,
		displayName: r.displayName,
		requestedScope: r.requestedScope,
		requestedAt: r.requestedAt,
	}));

	return NextResponse.json({ pending });
}
