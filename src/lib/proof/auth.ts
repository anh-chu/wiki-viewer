/**
 * Agent authentication.
 *
 * Accepts one of:
 *  1. Better Auth session cookie (browser UI) — treated as a synthetic user agent
 *  2. Bearer token + X-Agent-Id header (registered external agents)
 *
 * AGENT_BEARER_TOKEN env var is not used.
 */
import type { Agent } from "./registry";
import { lookupAgentByToken, updateLastSeen } from "./registry";
import { matchGlob } from "./glob";
import { getSessionFromRequest } from "@/lib/auth/server";

// One-time warning if legacy env var is set
if (process.env.AGENT_BEARER_TOKEN) {
	console.warn(
		"[wiki-viewer] AGENT_BEARER_TOKEN is no longer used; manage agents via the AI Panel.",
	);
}

export type CheckAuthResult =
	| { ok: true; agent: Agent }
	| { ok: false; code: string; message?: string };

export async function checkAuth(req: Request): Promise<CheckAuthResult> {
	// 1. Try Better Auth session (browser same-origin requests)
	const session = await getSessionFromRequest(req);
	if (session?.user) {
		const u = session.user;
		return {
			ok: true,
			agent: {
				id: `user:${u.id}`,
				displayName: u.name,
				tokenHash: "",
				scope: { paths: ["**/*"], ops: ["read", "mutate"] },
				createdAt: "",
				lastSeen: "",
			},
		};
	}

	// 2. Try Bearer token (external agents)
	const authHeader = req.headers.get("authorization") ?? "";
	const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
	if (!token) {
		return { ok: false, code: "UNAUTHORIZED", message: "No credentials" };
	}

	const agent = await lookupAgentByToken(token);
	if (!agent) {
		return { ok: false, code: "UNAUTHORIZED", message: "Unknown or invalid token" };
	}

	// X-Agent-Id MUST be present and MUST equal the agent id bound to this token.
	const presentedId = req.headers.get("x-agent-id") ?? "";
	if (!presentedId) {
		return { ok: false, code: "UNAUTHORIZED", message: "X-Agent-Id header required" };
	}
	if (presentedId !== agent.id) {
		return { ok: false, code: "UNAUTHORIZED", message: "X-Agent-Id does not match token owner" };
	}

	void updateLastSeen(agent.id);

	return { ok: true, agent };
}

// ── Scope enforcement ─────────────────────────────────────────────────────────

export interface ScopeParams {
	filePath?: string;
	op: "read" | "mutate";
}

export function enforceScope(
	agent: Agent,
	params: ScopeParams,
): { ok: true } | { ok: false; code: "FORBIDDEN"; message: string } {
	const { scope } = agent;

	if (!scope.ops.includes(params.op)) {
		return { ok: false, code: "FORBIDDEN", message: `Agent scope does not allow "${params.op}"` };
	}

	if (params.filePath) {
		const matched = scope.paths.some((pattern) => matchGlob(pattern, params.filePath!));
		if (!matched) {
			return {
				ok: false,
				code: "FORBIDDEN",
				message: `Agent scope does not cover path "${params.filePath}"`,
			};
		}
	}

	return { ok: true };
}

/** Verify the `by` field on a mutation matches the authenticated agent id. */
export function verifyBy(
	agent: Agent,
	by: string | undefined | null,
): { ok: true } | { ok: false; code: "FORBIDDEN"; message: string } {
	// Browser/session users: accept user:*, "human", "owner" (back-compat)
	if (agent.id.startsWith("user:")) {
		if (!by || by === "owner" || by === "human" || by.startsWith("human:") || by === agent.id) {
			return { ok: true };
		}
		return {
			ok: false,
			code: "FORBIDDEN",
			message: `User agent must use "human", "owner", or own id in "by" field`,
		};
	}

	// AI agents must match their registered id exactly
	if (by !== agent.id) {
		return {
			ok: false,
			code: "FORBIDDEN",
			message: `"by" field must equal agent id "${agent.id}"`,
		};
	}
	return { ok: true };
}

/** @deprecated No longer relevant — always returns false */
export function hasTokenConfigured(): boolean {
	return false;
}
