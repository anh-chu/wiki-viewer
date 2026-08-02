/**
 * Password-unlock grant for protected public shares.
 *
 * Design:
 * - Payload: share token + absolute expiry (ms since epoch).
 * - MAC: HMAC-SHA256 keyed by the stored passwordHash.
 * - Transport: HttpOnly, SameSite=Strict cookie scoped to /api/share/<token>.
 *
 * The plaintext password is never written to a cookie, URL, or log.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const GRANT_TTL_MS = 15 * 60 * 1000; // 15 minutes
const COOKIE_MAX_AGE_SECONDS = 900; // 15 minutes
const SHA256_HEX_PREFIX_LEN = 24; // first 12 hex bytes

interface GrantPayload {
	t: string;
	e: number;
}

function grantName(token: string): string {
	const prefix = createHash("sha256").update(token).digest("hex").slice(0, SHA256_HEX_PREFIX_LEN);
	return `wv_share_${prefix}`;
}

function encodePayload(payload: GrantPayload): string {
	return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function signGrant(payload: GrantPayload, passwordHash: string): string {
	const data = `${payload.e}|${payload.t}`;
	return createHmac("sha256", passwordHash).update(data).digest("hex");
}

export function createGrant(token: string, passwordHash: string): { name: string; value: string } {
	const expiry = Date.now() + GRANT_TTL_MS;
	const payload: GrantPayload = { t: token, e: expiry };
	const signature = signGrant(payload, passwordHash);
	const value = `${encodePayload(payload)}.${signature}`;
	return { name: grantName(token), value };
}

export function verifyGrant(token: string, value: string, passwordHash: string): boolean {
	const dot = value.indexOf(".");
	if (dot === -1) return false;

	const payloadPart = value.slice(0, dot);
	const signature = value.slice(dot + 1);

	let payload: GrantPayload;
	try {
		payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as GrantPayload;
	} catch {
		return false;
	}

	if (payload.t !== token) return false;
	if (typeof payload.e !== "number") return false;
	if (payload.e <= Date.now()) return false;

	const expected = signGrant(payload, passwordHash);
	const expectedBuf = Buffer.from(expected, "hex");
	const actualBuf = Buffer.from(signature, "hex");
	if (expectedBuf.length !== actualBuf.length) return false;

	return timingSafeEqual(expectedBuf, actualBuf);
}

export function serializeUnlockCookie(
	request: Request,
	token: string,
	passwordHash: string,
): string {
	const { name, value } = createGrant(token, passwordHash);
	const url = new URL(request.url);
	const parts = [
		`${name}=${value}`,
		"HttpOnly",
		"SameSite=Strict",
		`Path=${url.pathname}`,
		`Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
	];
	if (url.protocol === "https:") {
		parts.push("Secure");
	}
	return parts.join("; ");
}

export function findGrantCookie(request: Request, token: string): string | undefined {
	const header = request.headers.get("cookie") ?? "";
	const name = grantName(token);
	for (const segment of header.split(";")) {
		const eq = segment.indexOf("=");
		if (eq <= 0) continue;
		const segName = segment.slice(0, eq).trim();
		if (segName === name) {
			return segment.slice(eq + 1).trim();
		}
	}
	return undefined;
}

export function isUnlocked(request: Request, token: string, passwordHash: string): boolean {
	const value = findGrantCookie(request, token);
	if (!value) return false;
	return verifyGrant(token, value, passwordHash);
}

/**
 * Escape a filename for a quoted `Content-Disposition` parameter value.
 * Removes control characters and escapes backslash / double-quote.
 */
export function inlineContentDisposition(filename: string): string {
	const safe = filename
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"');
	return `inline; filename="${safe}"`;
}
