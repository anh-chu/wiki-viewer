/**
 * GET  /api/system/auth-settings — read the effective signup allowlist.
 * PUT  /api/system/auth-settings — update the allowlist in config.json.
 *
 * Single-tenant local app: any authenticated user may read/edit. The effective
 * list resolves config first, env as fallback (see getAllowlist). `source`
 * tells the UI where the active values came from so it can warn that editing
 * here overrides the env vars.
 */
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { getAllowlist } from "@/lib/auth/allowlist";
import { readConfig, writeConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const config = await readConfig();
	const effective = await getAllowlist();
	const usingConfig =
		(config.allowedEmails?.length ?? 0) > 0 ||
		(config.allowedDomains?.length ?? 0) > 0;

	return NextResponse.json({
		allowedEmails: effective.emails,
		allowedDomains: effective.domains,
		source: usingConfig ? "config" : "env",
		envFallbackActive: !usingConfig,
		rateLimit: Number(process.env.AGENT_RATE_LIMIT) || 60,
	});
}

function normalizeList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((v): v is string => typeof v === "string")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export async function PUT(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	let body: { allowedEmails?: unknown; allowedDomains?: unknown };
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const allowedEmails = normalizeList(body.allowedEmails);
	const allowedDomains = normalizeList(body.allowedDomains);

	// Reject obviously malformed email entries (must contain a single @ with text
	// on both sides). Domains are looser but must not contain @ or spaces.
	const badEmail = allowedEmails.find((e) => !/^[^@\s]+@[^@\s]+$/.test(e));
	if (badEmail)
		return NextResponse.json(
			{ error: `Invalid email entry: ${badEmail}` },
			{ status: 400 },
		);
	const badDomain = allowedDomains.find((d) => /[@\s]/.test(d));
	if (badDomain)
		return NextResponse.json(
			{ error: `Invalid domain entry: ${badDomain}` },
			{ status: 400 },
		);

	await writeConfig({ allowedEmails, allowedDomains });

	return NextResponse.json({
		ok: true,
		allowedEmails,
		allowedDomains,
		source: allowedEmails.length || allowedDomains.length ? "config" : "env",
	});
}
