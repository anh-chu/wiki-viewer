/**
 * Short-lived, directory-scoped capability token for HTML previews.
 *
 * WHY THIS EXISTS: an HTML preview runs in a sandboxed iframe without
 * `allow-same-origin` (the security invariant in docs/ux-contracts.md 3.2), so
 * the previewed document has a transient origin. Requests it initiates — the
 * nested `<iframe src="sibling.html">` an inner page loads, plus that page's
 * CSS/JS/images — are therefore a cross-site context: the browser withholds the
 * session cookie, and the plain `_ws`/`_root` asset paths fail `401`/`403`.
 * Authorization for those subrequests has to travel in the URL itself.
 *
 * It travels in the PATH, not a query string, because the browser drops the
 * query on relative navigation (`href="blog.html"`, `<img src="pic.png">`),
 * which is the same reason the workspace sentinel lives in the path.
 *
 * SCOPE: the token authorizes reads under one directory (the previewed file's
 * own directory subtree), never the whole workspace — a hostile HTML file in a
 * workspace must not be able to read its siblings' secrets by reading its own
 * URL. `exp` bounds the damage of a leaked token.
 *
 * The HMAC key is the embed API key at ~/.wiki-viewer/api-key (0600). Anyone
 * who can read that file already holds this process's filesystem privileges, so
 * deriving a second secret from it grants no new reach, and it survives
 * restarts (a per-process random secret would not).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureApiKey } from "@/lib/auth/api-key";

/** How long an issued token stays valid. */
export const PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface PreviewScope {
	/** Absolute workspace root the token was issued for. */
	rootDir: string;
	/** Root-relative directory the token is limited to ("" = the root itself). */
	prefix: string;
}

interface TokenPayload extends PreviewScope {
	/** Expiry, epoch milliseconds. */
	exp: number;
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function signature(payload: string): string {
	return base64url(createHmac("sha256", ensureApiKey()).update(payload).digest());
}

/**
 * Issue a token for one directory subtree. `prefix` must already be a
 * normalized root-relative directory (use `previewPrefixFor`).
 */
export function issuePreviewToken(scope: PreviewScope, now = Date.now()): { token: string; expiresAt: number } {
	const expiresAt = now + PREVIEW_TOKEN_TTL_MS;
	const payload: TokenPayload = { rootDir: scope.rootDir, prefix: scope.prefix, exp: expiresAt };
	const body = base64url(JSON.stringify(payload));
	return { token: `${body}.${signature(body)}`, expiresAt };
}

/**
 * Verify a token. Returns the scope, or null for a malformed, tampered, or
 * expired token — one indistinguishable failure so a caller learns nothing
 * about which part was wrong.
 */
export function verifyPreviewToken(token: string, now = Date.now()): PreviewScope | null {
	const dot = token.indexOf(".");
	if (dot < 1) return null;
	const body = token.slice(0, dot);
	const provided = token.slice(dot + 1);
	const expected = signature(body);
	if (provided.length !== expected.length) return null;
	if (!timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(expected, "utf-8"))) return null;

	let payload: TokenPayload;
	try {
		payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
	} catch {
		return null;
	}
	if (
		typeof payload?.rootDir !== "string" ||
		payload.rootDir === "" ||
		typeof payload?.prefix !== "string" ||
		typeof payload?.exp !== "number" ||
		!Number.isFinite(payload.exp) ||
		payload.exp <= now
	) {
		return null;
	}
	return { rootDir: payload.rootDir, prefix: payload.prefix };
}

/**
 * Directory prefix to scope a preview of `relPath` to. A path of "docs/a.html"
 * scopes to "docs"; a root-level file scopes to "" (the root itself).
 */
export function previewPrefixFor(relPath: string): string {
	const norm = relPath.replace(/^\/+/, "").replace(/\/+$/, "");
	const slash = norm.lastIndexOf("/");
	return slash <= 0 ? "" : norm.slice(0, slash);
}

/**
 * True when `relPath` (root-relative, already path-resolved) stays inside the
 * token's directory subtree. Rejects the sibling-escape a token must not allow.
 */
export function withinPreviewPrefix(prefix: string, relPath: string): boolean {
	const norm = relPath.replace(/^\/+/, "");
	if (prefix === "") return true;
	return norm === prefix || norm.startsWith(`${prefix}/`);
}
