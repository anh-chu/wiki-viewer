/**
 * POST /api/agent/admin/registrations/:regId/approve
 *
 * Approve a pending registration. Mints a token, stores agent, marks for pickup.
 * Requires authenticated user session.
 *
 * Body (optional): { scope?: AgentScope }  — override requested scope.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { getRegistration, approveRegistration } from "@/lib/proof/pending";
import { addAgent, hashToken } from "@/lib/proof/registry";
import type { AgentScope } from "@/lib/proof/registry";
import { validateScope } from "@/app/api/agent/register/route";

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

	// Optional scope override — validate if present
	let scope: AgentScope = reg.requestedScope;
	try {
		const body = (await req.json()) as { scope?: unknown };
		if (body.scope !== undefined && body.scope !== null) {
			if (typeof body.scope !== "object" || Array.isArray(body.scope)) {
				return NextResponse.json(
					{ error: "INVALID_PAYLOAD", message: "scope must be an object" },
					{ status: 400 },
				);
			}
			const result = validateScope(body.scope as Record<string, unknown>);
			if ("error" in result) {
				return NextResponse.json(
					{ error: "INVALID_PAYLOAD", message: result.error },
					{ status: 400 },
				);
			}
			scope = result;
		}
	} catch {
		// No body or invalid JSON — use requestedScope
	}

	// Mint token
	const tokenPlaintext = randomBytes(32).toString("hex");
	const tokenHash = hashToken(tokenPlaintext);

	// Store agent in registry, bound to the approving user.
	await addAgent({
		id: reg.agentId,
		displayName: reg.displayName,
		tokenHash,
		scope,
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
		ownerUserId: owner.user.id,
	});

	// Mark as approved with one-shot pickup token
	approveRegistration(regId, tokenPlaintext);

	return NextResponse.json({ ok: true, agentId: reg.agentId });
}
