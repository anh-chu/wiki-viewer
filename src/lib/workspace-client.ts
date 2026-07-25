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

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * May this parent window send us `open-file` postMessages?
 *
 * Previously this was a hardcoded loopback regex, which broke every non-local
 * deployment: embedding hosts are commonly reached over a Tailscale hostname or
 * behind a reverse proxy, and the failure was invisible — the initial `?file=`
 * load is a NAVIGATION so it kept working, then every subsequent click was
 * silently dropped. Feature appears healthy, then appears to randomly stop.
 *
 * Trust rules:
 *   1. Loopback — the local/dev case.
 *   2. Our own origin — a same-origin embed.
 *   3. A host-supplied `?root=` is present — key-derived trust. The page only
 *      renders with a root once the API key has validated (middleware 307s on a
 *      bad key and 400s on a bad root), so the parent demonstrably holds a key
 *      that already grants filesystem access to this process. Restricting which
 *      hostname it may frame from adds nothing it couldn't already do.
 *
 * Accepting an arbitrary parent origin is bounded: this app never postMessages
 * OUT, and cross-origin framing means the parent cannot read what we render, so
 * the worst a hostile framer achieves is navigating the panel — no disclosure.
 */
export function isTrustedEmbedParent(
	origin: string,
	opts: { selfOrigin: string | null; hasHostRoot: boolean },
): boolean {
	if (LOOPBACK_ORIGIN.test(origin)) return true;
	if (opts.selfOrigin && origin === opts.selfOrigin) return true;
	if (opts.hasHostRoot) return true;
	return false;
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
 * Append the workspace scope to a workspace-scoped URL.
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
	if (!root && !wsId) return url;

	// Split on first '?' to isolate the pathname
	const qIdx = url.indexOf("?");
	const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
	const search = qIdx === -1 ? "" : url.slice(qIdx + 1);

	if (!needsWs(pathname)) return url;

	// Don't double-inject
	const params = new URLSearchParams(search);
	if (params.has("root") || params.has("ws")) return url;

	if (root) params.set("root", root);
	else if (wsId) params.set("ws", wsId);
	return `${pathname}?${params.toString()}`;
}

/**
 * drop-in fetch replacement that injects ?ws=<activeId> on workspace-scoped
 * URLs. Non-scoped URLs pass through unchanged.
 */
export function wsFetch(input: string, init?: RequestInit): Promise<Response> {
	return fetch(withWs(input), init);
}
