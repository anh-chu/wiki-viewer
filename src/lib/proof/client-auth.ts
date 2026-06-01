/**
 * Browser-side auth for same-origin UI requests.
 *
 * Authentication is now handled by the owner cookie (wv_owner) set via
 * /api/owner/init. Same-origin fetch automatically attaches cookies, so no
 * explicit Authorization header is needed from the browser UI.
 *
 * All fetch calls from the browser must use credentials: "same-origin" (the
 * default) or credentials: "include".
 */

/** @deprecated No longer returns a token. Owner cookie is used instead. */
export function getAgentToken(): string | null {
	return null;
}

/**
 * Returns empty object — authentication is via owner cookie automatically.
 * Kept for backwards-compat with call sites.
 */
export function authHeaders(): HeadersInit {
	return {};
}
