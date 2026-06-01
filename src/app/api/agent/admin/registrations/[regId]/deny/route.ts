/**
 * POST /api/agent/admin/registrations/:regId/deny
 *
 * Deny a pending registration. Requires authenticated user session.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { getRegistration, denyRegistration } from "@/lib/proof/pending";

export const runtime = "nodejs";

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ regId: string }> },
): Promise<NextResponse> {
	const owner = await requireUser(req);
	if (!owner.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const { regId } = await params;
	const reg = getRegistration(regId);
	if (!reg) {
		return NextResponse.json({ error: "NOT_FOUND", message: "Registration not found" }, { status: 404 });
	}
	if (reg.status !== "pending") {
		return NextResponse.json(
			{ error: "CONFLICT", message: `Registration is already ${reg.status}` },
			{ status: 409 },
		);
	}

	denyRegistration(regId);

	return NextResponse.json({ ok: true });
}
