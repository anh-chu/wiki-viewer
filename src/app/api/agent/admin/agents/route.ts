/**
 * GET /api/agent/admin/agents
 *
 * List registered agents (no token hashes). Requires authenticated user session.
 */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { readRegistry } from "@/lib/proof/registry";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
	const owner = await requireUser(req);
	if (!owner.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const registry = await readRegistry();
	// Show agents owned by this user. Legacy agents (no ownerUserId) are visible
	// to all authenticated users for back-compat.
	const agents = (registry?.agents ?? [])
		.filter((a) => a.ownerUserId === undefined || a.ownerUserId === owner.user.id)
		.map((a) => ({
			id: a.id,
			displayName: a.displayName,
			scope: a.scope,
			createdAt: a.createdAt,
			lastSeen: a.lastSeen,
			ownerUserId: a.ownerUserId,
		}));

	return NextResponse.json({ agents });
}
