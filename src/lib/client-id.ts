/**
 * A random id for client-generated keys (idempotency keys, etc).
 *
 * `crypto.randomUUID()` only exists in a secure context (https / localhost), so
 * it throws on plain-http remotes. This helper uses it when available and falls
 * back to `crypto.getRandomValues` (widely available) or Math.random.
 */
export function clientId(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c && typeof c.randomUUID === "function") {
		try {
			return c.randomUUID();
		} catch {
			/* secure-context-only; fall through */
		}
	}
	if (c && typeof c.getRandomValues === "function") {
		const b = new Uint8Array(16);
		c.getRandomValues(b);
		// RFC-4122-ish v4 shape; uniqueness is what matters here, not strict spec.
		b[6] = (b[6] & 0x0f) | 0x40;
		b[8] = (b[8] & 0x3f) | 0x80;
		const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	}
	return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
