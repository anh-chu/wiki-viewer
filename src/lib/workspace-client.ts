/**
 * workspace-client.ts — browser-safe ws injection helpers.
 * No React, no server imports. Safe to use in any "use client" file.
 */

import { apiUrl } from "@/lib/url-prefix";

/**
 * URL prefixes that are workspace-scoped and need ?ws= injected.
 * Rules:
 *   include:  /api/wiki, /api/assets/, /api/agent/ (except sub-paths below),
 *             /api/upload/, /api/system/reveal
 *   exclude:  /api/agent/admin, /api/agent/register, /api/agents
 *             (those are global registrations, not file-workspace calls)
 */
const WS_SCOPED_PREFIXES = [
	"/api/wiki",
	"/api/assets/",
	"/api/upload/",
	"/api/pdf/",
	"/api/system/reveal",
	"/api/app-proxy/",
];

const WS_AGENT_PREFIX = "/api/agent/";

const WS_AGENT_EXCLUDED_PREFIXES = [
	"/api/agent/admin",
	"/api/agent/register",
	"/api/agents",
];

export function getActiveWorkspaceId(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("ws");
}

/**
 * The request-scoped root supplied by an embedding host (?root=), or null.
 *
 * Present only in embed mode; honored server-side ONLY for API-key-authenticated
 * requests (see workspace-context.ts). When set it takes precedence over ?ws=,
 * so every workspace-scoped fetch must carry it instead.
 */
export function getEphemeralRoot(): string | null {
	if (typeof window === "undefined") return null;
	return new URLSearchParams(window.location.search).get("root");
}

/**
 * Convert a host-supplied ABSOLUTE path into the root-relative form the rest of
 * the app (and every API route) uses.
 *
 * Internal paths never carry a leading slash — the tree API builds them as
 * `dir ? \`${dir}/${name}\` : name` — so a leading "/" reliably marks a path
 * from the embedding host's filesystem.
 *
 * Returns:
 *   - the input unchanged when it's already relative
 *   - "" when target IS the root
 *   - the root-relative remainder when target is inside root
 *   - null when target is absolute and outside root (caller should reject), or
 *     absolute with no known root
 */
export function toRootRelative(target: string, root: string | null): string | null {
	if (!target.startsWith("/")) return target; // already root-relative
	if (!root) return null;

	const normRoot = root.endsWith("/") ? root.slice(0, -1) : root;
	if (target === normRoot) return "";
	if (target.startsWith(normRoot + "/")) return target.slice(normRoot.length + 1);
	return null; // outside the root
}

/** Returns true if this URL is workspace-scoped and needs ?ws= appended. */
function needsWs(pathname: string): boolean {
	// Excluded patterns first (match on prefix + segment boundary so
	// "/api/agent/adminfoo" is NOT treated as "/api/agent/admin").
	for (const ex of WS_AGENT_EXCLUDED_PREFIXES) {
		if (pathname === ex || pathname.startsWith(ex + "/")) return false;
	}
	if (pathname.startsWith(WS_AGENT_PREFIX)) return true;
	for (const prefix of WS_SCOPED_PREFIXES) {
		if (pathname.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Append the workspace scope to a workspace-scoped URL, then apply the URL
 * prefix. Every return path goes through apiUrl() so lite deployments under
 * /wiki and full deployments at / both work.
 *
 * Injects `root=` when an embedding host supplied one (it takes precedence
 * server-side), otherwise `ws=<activeId>`. Skips URLs that aren't
 * workspace-scoped and never double-injects.
 *
 * Handles both plain paths (/api/wiki) and paths with existing query strings
 * (/api/wiki/content?path=foo → /api/wiki/content?path=foo&ws=<id>).
 */
export function withWs(url: string): string {
	const root = getEphemeralRoot();
	// root wins over ws: sending both would be harmless (the server prefers
	// root) but it's clearer to send exactly the one that decides resolution.
	const wsId = root ? null : getActiveWorkspaceId();

	// Split on first '?' to isolate the pathname
	const qIdx = url.indexOf("?");
	const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
	const search = qIdx === -1 ? "" : url.slice(qIdx + 1);

	if (needsWs(pathname)) {
		const params = new URLSearchParams(search);
		// Don't double-inject
		if (!params.has("root") && !params.has("ws")) {
			if (root) params.set("root", root);
			else if (wsId) params.set("ws", wsId);
			const qs = params.toString();
			return apiUrl(qs ? `${pathname}?${qs}` : pathname);
		}
	}

	return apiUrl(url);
}

/**
 * drop-in fetch replacement that injects ?ws=<activeId> on workspace-scoped
 * URLs. Non-scoped URLs pass through unchanged.
 */
export function wsFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(withWs(input), init);
}
