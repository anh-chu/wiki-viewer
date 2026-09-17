/**
 * POST /api/agent/register
 *
 * Registration request. Two paths:
 *  1. Anonymous TOFU: no auth → 202 pending, owner approves in UI, agent polls.
 *  2. Service-token bootstrap: valid X-Service-Token header → auto-approved.
 *     Token is minted inline and returned in the 200 response (no polling,
 *     no pickup, no UI step).
 */
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createRegistration } from "@/lib/proof/pending";
import type { AgentScope } from "@/lib/proof/registry";
import { addAgent, hashToken, lookupAgentById } from "@/lib/proof/registry";
import { isServiceTokenRequest } from "@/lib/auth/service-token";
import { checkRegisterRateLimit } from "@/lib/proof/register-rate-limit";

export const runtime = "nodejs";

const AGENT_ID_RE = /^ai:[a-z][a-z0-9-]{0,30}$/i;
const VALID_OPS = new Set(["read", "mutate", "delete"]);

function validateScope(s: Record<string, unknown>): AgentScope | { error: string } {
	if (!Array.isArray(s.paths) || s.paths.length === 0 || s.paths.length > 20) {
		return { error: "scope.paths must be an array of 1\u201320 glob pattern strings" };
	}
	for (const p of s.paths) {
		if (typeof p !== "string" || p.length < 1 || p.length > 200) {
			return { error: "Each scope.paths entry must be a string of 1\u2013200 characters" };
		}
	}
	if (!Array.isArray(s.ops) || s.ops.length === 0) {
		return { error: "scope.ops must be a non-empty array" };
	}
	for (const op of s.ops) {
		if (!VALID_OPS.has(op as string)) {
			return { error: `scope.ops values must be "read", "mutate", or "delete"` };
		}
	}
	// Optional workspaceId: if present must be a non-empty string ≤ 64 chars.
	let workspaceId: string | undefined;
	if (s.workspaceId !== undefined) {
		if (typeof s.workspaceId !== "string" || s.workspaceId.length < 1 || s.workspaceId.length > 64) {
			return { error: "scope.workspaceId must be a string of 1\u201364 characters" };
		}
		workspaceId = s.workspaceId;
	}
	return { paths: s.paths as string[], ops: s.ops as Array<"read" | "mutate" | "delete">, ...(workspaceId !== undefined ? { workspaceId } : {}) };
}

/** Exported for reuse in approve route. */
export { validateScope };

export async function POST(req: Request): Promise<NextResponse> {
	// Rate limit by remote IP (best-effort; fall back to global key)
	const ip =
		(req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ||
		"__global__";
	if (!checkRegisterRateLimit(ip)) {
		return NextResponse.json(
			{ error: "RATE_LIMITED", message: "Too many registration attempts" },
			{ status: 429 },
		);
	}

	let body: { id?: unknown; displayName?: unknown; scope?: unknown };
	try {
		body = (await req.json()) as { id?: unknown; displayName?: unknown; scope?: unknown };
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: "Invalid JSON" }, { status: 400 });
	}

	if (typeof body.id !== "string" || !AGENT_ID_RE.test(body.id)) {
		return NextResponse.json(
			{
				error: "INVALID_PAYLOAD",
				message: "id must match /^ai:[a-z][a-z0-9-]{0,30}$/i (e.g. ai:claude)",
			},
			{ status: 400 },
		);
	}

	// displayName: required, 1–80 chars
	if (
		typeof body.displayName !== "string" ||
		body.displayName.trim().length < 1 ||
		body.displayName.trim().length > 80
	) {
		return NextResponse.json(
			{ error: "INVALID_PAYLOAD", message: "displayName must be a string of 1\u201380 characters" },
			{ status: 400 },
		);
	}
	const displayName = body.displayName.trim();

	// scope: required, must pass validation
	if (
		body.scope === undefined ||
		body.scope === null ||
		typeof body.scope !== "object" ||
		Array.isArray(body.scope)
	) {
		return NextResponse.json(
			{ error: "INVALID_PAYLOAD", message: "scope is required" },
			{ status: 400 },
		);
	}
	const scopeResult = validateScope(body.scope as Record<string, unknown>);
	if ("error" in scopeResult) {
		return NextResponse.json({ error: "INVALID_PAYLOAD", message: scopeResult.error }, { status: 400 });
	}
	const requestedScope: AgentScope = scopeResult;

	// ── Service-token bootstrap: auto-approve, mint inline ─────────────────────
	// A valid service token proves host trust (the token lives at
	// ~/.wiki-viewer/service-token, 0600, same machine as the server), so the
	// caller gets its requested scope without human approval. The minted
	// per-agent token is returned once in this response — never persisted in
	// plaintext by the server.
	if (isServiceTokenRequest(req)) {
		const existing = await lookupAgentById(body.id);
		const tokenPlaintext = `wv_tok_${randomBytes(32).toString("hex")}`;
		await addAgent({
			id: body.id,
			displayName,
			tokenHash: hashToken(tokenPlaintext),
			scope: requestedScope,
			createdAt: new Date().toISOString(),
			lastSeen: new Date().toISOString(),
		});
		return NextResponse.json(
			{
				status: "approved",
				agentId: body.id,
				token: tokenPlaintext,
				...(existing ? { warning: `Replaced the existing token for ${body.id}; the previous token is now invalid.` } : {}),
			},
			{ status: 200 },
		);
	}

	const reg = createRegistration({ agentId: body.id, displayName, requestedScope });

	return NextResponse.json(
		{
			registrationId: reg.registrationId,
			pollUrl: `/api/agent/register/${reg.registrationId}`,
			status: "pending",
		},
		{ status: 202 },
	);
}
