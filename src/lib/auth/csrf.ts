import { NextResponse } from "next/server";

/**
 * Reject cross-origin state-changing requests that arrive with a session cookie.
 * Bearer-only requests (no Origin/Referer) pass through — they are authenticated
 * separately and are not vulnerable to CSRF.
 *
 * Returns null if the request may proceed, or a NextResponse(403) to return.
 *
 * Call at the top of every POST/PUT/DELETE/PATCH handler in /api/wiki/* and
 * /api/system/* before requireUser.
 */
export function checkOrigin(req: Request): NextResponse | null {
	const method = req.method.toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

	// Bearer-auth agents typically omit Origin/Referer — let checkAuth handle them.
	const origin = req.headers.get("origin");
	const referer = req.headers.get("referer");
	if (!origin && !referer) return null;

	const allowed = buildAllowedOrigins(req.headers.get("host") ?? "");

	if (origin) {
		if (allowed.has(origin)) return null;
		return NextResponse.json(
			{ error: "FORBIDDEN", message: "Bad origin" },
			{ status: 403 },
		);
	}

	if (referer) {
		try {
			const { protocol, host } = new URL(referer);
			if (allowed.has(`${protocol}//${host}`)) return null;
		} catch {
			// malformed Referer — reject
		}
		return NextResponse.json(
			{ error: "FORBIDDEN", message: "Bad referer" },
			{ status: 403 },
		);
	}

	return null;
}

function buildAllowedOrigins(hostHeader: string): Set<string> {
	const hostname = hostHeader.split(":")[0];
	const extra = (process.env.WIKI_OWNER_HOSTS ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);

	const hosts = Array.from(new Set(["localhost", "127.0.0.1", hostname, ...extra]));
	const ports = ["", ":3000", ":3003"];
	if (hostHeader.includes(":")) ports.push(":" + hostHeader.split(":")[1]);

	const allowed = new Set<string>();
	for (const h of hosts) {
		for (const proto of ["http", "https"]) {
			for (const port of ports) {
				allowed.add(`${proto}://${h}${port}`);
			}
		}
	}
	return allowed;
}
