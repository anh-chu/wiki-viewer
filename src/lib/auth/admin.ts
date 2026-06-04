/**
 * Global admin role.
 *
 * Resolution order:
 *   1. WIKI_ADMIN_EMAILS env (csv, case-insensitive) — seed/override, headless-friendly.
 *   2. config.adminUserIds — persisted list managed via the admin API.
 *
 * Bootstrap: if adminUserIds is empty AND no WIKI_ADMIN_EMAILS is set,
 * the first call to ensureBootstrapAdmin(userId) writes that user as admin.
 * Called lazily on the first authenticated request (race-safe: re-read inside).
 */

import { readConfig, updateConfig } from "@/lib/config";
import { requireUser } from "@/lib/auth/server";

// ── Internal helpers ───────────────────────────────────────────────────────────

function adminEmailsFromEnv(): string[] {
	return (process.env.WIKI_ADMIN_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function isAdmin(userId: string, email?: string): Promise<boolean> {
	// Env override: any matching email is admin
	if (email) {
		const envAdmins = adminEmailsFromEnv();
		if (envAdmins.length > 0 && envAdmins.includes(email.toLowerCase())) {
			return true;
		}
	}
	const cfg = await readConfig();
	return (cfg.adminUserIds ?? []).includes(userId);
}

export async function listAdmins(): Promise<string[]> {
	const cfg = await readConfig();
	return cfg.adminUserIds ?? [];
}

export async function addAdmin(userId: string): Promise<void> {
	await updateConfig((cfg) => {
		const current = cfg.adminUserIds ?? [];
		if (current.includes(userId)) return cfg;
		return { ...cfg, adminUserIds: [...current, userId] };
	});
}

export async function removeAdmin(userId: string): Promise<void> {
	const hasEnvFallback = adminEmailsFromEnv().length > 0;
	let rejected = false;
	await updateConfig((cfg) => {
		const current = cfg.adminUserIds ?? [];
		const next = current.filter((id) => id !== userId);
		// Refuse to remove last admin if no env fallback exists
		if (next.length === 0 && !hasEnvFallback) {
			rejected = true;
			return cfg;
		}
		return { ...cfg, adminUserIds: next };
	});
	if (rejected) {
		throw new Error(
			"LAST_ADMIN: cannot remove the last admin with no WIKI_ADMIN_EMAILS configured",
		);
	}
}

/**
 * If adminUserIds is empty AND no WIKI_ADMIN_EMAILS, write userId as the first
 * admin.  Safe to call concurrently: re-reads inside before writing.
 */
export async function ensureBootstrapAdmin(userId: string): Promise<void> {
	if (adminEmailsFromEnv().length > 0) return; // env handles it

	// Fast-path read to avoid the serialized write when an admin already exists.
	const cfg = await readConfig();
	if ((cfg.adminUserIds ?? []).length > 0) return;

	let promoted = false;
	// Atomic: re-check inside the lock so only one concurrent caller writes.
	await updateConfig((fresh) => {
		if ((fresh.adminUserIds ?? []).length > 0) return fresh;
		promoted = true;
		return { ...fresh, adminUserIds: [userId] };
	});
	if (promoted) {
		console.log(`[wiki-viewer] Bootstrap: first user ${userId} promoted to admin`);
	}
}

/**
 * Use in route handlers.
 * Returns { ok: true, user } or { ok: false, status, code } ready for NextResponse.
 */
export async function requireAdmin(
	req: Request,
): Promise<
	| { ok: true; user: { id: string; email: string; name: string } }
	| { ok: false; status: number; code: string }
> {
	const auth = await requireUser(req);
	if (!auth.ok) return { ok: false, status: 401, code: "UNAUTHORIZED" };

	const admin = await isAdmin(auth.user.id, auth.user.email);
	if (!admin) return { ok: false, status: 403, code: "ADMIN_REQUIRED" };

	return { ok: true, user: auth.user };
}
