/**
 * Service token management — bootstrap credential for automated agent registration.
 *
 * A holder of this token may auto-approve its own agent registrations
 * (POST /api/agent/register with X-Service-Token), receiving a scoped
 * per-agent bearer token without human approval. Its only power is
 * "mint scoped agent tokens" — it grants no direct API access.
 *
 * Generated at startup, persisted to ~/.wiki-viewer/service-token (chmod 600).
 * validateServiceToken uses constant-time comparison to prevent timing attacks.
 */
import path from "node:path";
import os from "node:os";
import {
	existsSync,
	mkdirSync,
	chmodSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PATH = () =>
	path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer", "service-token");

/**
 * Ensure ~/.wiki-viewer/service-token exists; generate if missing.
 * Returns the current token. Safe to call multiple times (idempotent).
 */
export function ensureServiceToken(): string {
	mkdirSync(path.dirname(TOKEN_PATH()), { recursive: true });
	if (!existsSync(TOKEN_PATH())) {
		const token = `wv_svc_${randomBytes(32).toString("hex")}`;
		writeFileSync(TOKEN_PATH(), token, { mode: 0o600 });
		try {
			chmodSync(TOKEN_PATH(), 0o600);
		} catch {
			// chmod best-effort (some platforms don't support it)
		}
		return token;
	}
	return readFileSync(TOKEN_PATH(), "utf-8").trim();
}

/**
 * Read the stored token. Returns empty string if the file doesn't exist yet
 * (shouldn't happen after ensureServiceToken() runs at startup).
 */
export function getServiceToken(): string {
	if (!existsSync(TOKEN_PATH())) return "";
	return readFileSync(TOKEN_PATH(), "utf-8").trim();
}

/**
 * Rotate: generate a new token, overwrite the file, return it.
 * Invalidates every MCP config holding the old token; they will fail
 * registration with 401 until updated.
 */
export function rotateServiceToken(): string {
	mkdirSync(path.dirname(TOKEN_PATH()), { recursive: true });
	const token = `wv_svc_${randomBytes(32).toString("hex")}`;
	writeFileSync(TOKEN_PATH(), token, { mode: 0o600 });
	try {
		chmodSync(TOKEN_PATH(), 0o600);
	} catch {
		// best-effort
	}
	return token;
}

/**
 * Constant-time token comparison. Returns false for empty or
 * length-mismatched tokens.
 */
export function validateServiceToken(token: string): boolean {
	const stored = getServiceToken();
	if (!stored || !token) return false;
	if (stored.length !== token.length) return false;
	try {
		return timingSafeEqual(
			Buffer.from(stored, "utf-8"),
			Buffer.from(token, "utf-8"),
		);
	} catch {
		return false;
	}
}

/**
 * Extract the service token from the X-Service-Token header, if present.
 */
export function candidateServiceToken(req: Request): string {
	return req.headers.get("x-service-token")?.trim() ?? "";
}

/**
 * True if this request carries a valid service token.
 */
export function isServiceTokenRequest(req: Request): boolean {
	const token = candidateServiceToken(req);
	return token.length > 0 && validateServiceToken(token);
}
