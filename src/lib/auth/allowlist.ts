/**
 * Email allowlist check.
 *
 * Source of truth is ~/.wiki-viewer/config.json (allowedEmails / allowedDomains),
 * editable at runtime via the UI. Env vars AUTH_ALLOWED_EMAILS and
 * AUTH_ALLOWED_DOMAIN act as a fallback seed when config is empty, so existing
 * deployments keep working without a config file.
 *
 * If neither config nor env sets any restriction, all emails are allowed.
 */
import { readConfig } from "@/lib/config";

function splitList(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

/** Resolve the effective allowlist: config wins, env is the fallback. */
export async function getAllowlist(): Promise<{
	emails: string[];
	domains: string[];
}> {
	const config = await readConfig();
	const emails =
		config.allowedEmails && config.allowedEmails.length > 0
			? config.allowedEmails.map((s) => s.trim().toLowerCase()).filter(Boolean)
			: splitList(process.env.AUTH_ALLOWED_EMAILS);
	const domains =
		config.allowedDomains && config.allowedDomains.length > 0
			? config.allowedDomains.map((s) => s.trim().toLowerCase()).filter(Boolean)
			: splitList(process.env.AUTH_ALLOWED_DOMAIN);
	return { emails, domains };
}

export async function isEmailAllowed(email: string): Promise<boolean> {
	const { emails, domains } = await getAllowlist();

	// No restrictions set — allow all
	if (emails.length === 0 && domains.length === 0) return true;

	const e = email.toLowerCase();
	if (emails.includes(e)) return true;

	const at = e.lastIndexOf("@");
	if (at >= 0 && domains.includes(e.slice(at + 1))) return true;

	return false;
}
