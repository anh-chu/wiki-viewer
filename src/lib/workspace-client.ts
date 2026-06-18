/**
 * workspace-client.ts — browser-safe ws injection helpers.
 * No React, no server imports. Safe to use in any "use client" file.
 */

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
 * Append ?ws=<activeId> to a workspace-scoped URL if:
 *   - the URL needs ws injection (needsWs)
 *   - an active workspace id exists in the current URL
 *   - the URL doesn't already carry a ws= param
 *
 * Handles both plain paths (/api/wiki) and paths with existing query strings
 * (/api/wiki/content?path=foo → /api/wiki/content?path=foo&ws=<id>).
 */
export function withWs(url: string): string {
	const wsId = getActiveWorkspaceId();
	if (!wsId) return url;

	// Split on first '?' to isolate the pathname
	const qIdx = url.indexOf("?");
	const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
	const search = qIdx === -1 ? "" : url.slice(qIdx + 1);

	if (!needsWs(pathname)) return url;

	// Don't double-inject
	const params = new URLSearchParams(search);
	if (params.has("ws")) return url;

	params.set("ws", wsId);
	return `${pathname}?${params.toString()}`;
}

/**
 * drop-in fetch replacement that injects ?ws=<activeId> on workspace-scoped
 * URLs. Non-scoped URLs pass through unchanged.
 */
export function wsFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(withWs(input), init);
}
