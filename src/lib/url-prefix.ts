/**
 * URL prefix helpers for reverse-proxy deployments (wiki-viewer-lite).
 *
 * urlPrefix() returns the active prefix string ("" when not configured).
 * apiUrl() prepends it to paths starting with "/" and is idempotent.
 * isLite() reports whether this instance is running in lite mode.
 *
 * Server: reads process.env.WIKI_URL_PREFIX / WIKI_LITE.
 * Browser: reads the injected window.__WIKI_PREFIX / window.__WIKI_LITE globals.
 */

declare global {
	interface Window {
		__WIKI_PREFIX?: string;
		__WIKI_LITE?: boolean;
	}
}

/** Active URL prefix, or "" when not configured. */
export function urlPrefix(): string {
	if (typeof window !== "undefined") {
		return window.__WIKI_PREFIX ?? "";
	}
	return process.env.WIKI_URL_PREFIX ?? "";
}

/**
 * Prepend the active prefix to `path`.
 *
 * - Paths starting with "/" are prefixed (idempotent: already-prefixed inputs
 *   are returned unchanged).
 * - Paths NOT starting with "/" (relative, http(s)://, etc.) pass through.
 * - When the prefix is empty this is the identity function.
 */
export function apiUrl(path: string): string {
	if (!path.startsWith("/")) return path;
	const prefix = urlPrefix();
	if (!prefix) return path;
	if (path.startsWith(prefix + "/") || path === prefix) return path;
	return prefix + path;
}

/** True when this instance is running in wiki-viewer-lite mode. */
export function isLite(): boolean {
	if (typeof window !== "undefined") {
		return window.__WIKI_LITE === true;
	}
	return process.env.WIKI_LITE === "1";
}
