/**
 * In-memory store for pending agent registration requests.
 *
 * Cleared on server restart. The registrationId itself acts as the
 * agent's secret for polling (no separate PIN needed).
 */
import { randomBytes } from "node:crypto";
import type { AgentScope } from "./registry";

export type RegistrationStatus =
	| "pending"
	| "approved" // token has been minted but not yet picked up
	| "consumed" // token was picked up (one-shot)
	| "denied";

export interface PendingRegistration {
	registrationId: string;
	agentId: string;
	displayName: string;
	requestedScope: AgentScope;
	requestedAt: string; // ISO-8601
	status: RegistrationStatus;
	/** Plaintext token, present only after approval and before pickup. */
	tokenPlaintext?: string;
	/** ISO-8601 timestamp of approval/denial */
	resolvedAt?: string;
}

// Module-level singleton (survives Next.js HMR via globalThis)
const g = globalThis as typeof globalThis & {
	__wvPendingRegs?: Map<string, PendingRegistration>;
};
if (!g.__wvPendingRegs) {
	g.__wvPendingRegs = new Map();
}
const store: Map<string, PendingRegistration> = g.__wvPendingRegs;

export function createRegistration(opts: {
	agentId: string;
	displayName: string;
	requestedScope?: AgentScope;
}): PendingRegistration {
	const registrationId = `reg_${randomBytes(16).toString("hex")}`;
	const reg: PendingRegistration = {
		registrationId,
		agentId: opts.agentId,
		displayName: opts.displayName,
		requestedScope: opts.requestedScope ?? {
			paths: ["**/*"],
			ops: ["read", "mutate"],
		},
		requestedAt: new Date().toISOString(),
		status: "pending",
	};
	store.set(registrationId, reg);
	return reg;
}

export function getRegistration(id: string): PendingRegistration | undefined {
	return store.get(id);
}

export function listPendingRegistrations(): PendingRegistration[] {
	return [...store.values()].filter((r) => r.status === "pending");
}

export function listAllRegistrations(): PendingRegistration[] {
	return [...store.values()];
}

/** Mark as approved and stash one-shot token. */
export function approveRegistration(id: string, tokenPlaintext: string): boolean {
	const reg = store.get(id);
	if (!reg || reg.status !== "pending") return false;
	reg.status = "approved";
	reg.tokenPlaintext = tokenPlaintext;
	reg.resolvedAt = new Date().toISOString();
	return true;
}

/** Consume (pick up) the one-shot token. Returns plaintext then clears it. */
export function consumeRegistration(id: string): string | null {
	const reg = store.get(id);
	if (!reg || reg.status !== "approved" || !reg.tokenPlaintext) return null;
	const token = reg.tokenPlaintext;
	reg.status = "consumed";
	reg.tokenPlaintext = undefined;
	return token;
}

export function denyRegistration(id: string): boolean {
	const reg = store.get(id);
	if (!reg || reg.status !== "pending") return false;
	reg.status = "denied";
	reg.resolvedAt = new Date().toISOString();
	return true;
}
