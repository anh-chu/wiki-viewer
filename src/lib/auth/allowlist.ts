/**
 * Email allowlist check.
 * Controlled by AUTH_ALLOWED_EMAILS and AUTH_ALLOWED_DOMAIN env vars.
 * If neither is set, all emails are allowed.
 */
export function isEmailAllowed(email: string): boolean {
	const explicit = (process.env.AUTH_ALLOWED_EMAILS ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const domains = (process.env.AUTH_ALLOWED_DOMAIN ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	// No restrictions set — allow all
	if (explicit.length === 0 && domains.length === 0) return true;

	const e = email.toLowerCase();
	if (explicit.includes(e)) return true;

	const at = e.lastIndexOf("@");
	if (at >= 0 && domains.includes(e.slice(at + 1))) return true;

	return false;
}
