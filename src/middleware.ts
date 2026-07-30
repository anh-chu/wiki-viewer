import { NextResponse, type NextRequest } from "next/server";

// Node.js runtime required: middleware reads node:fs to validate the embed API key.
// Edge runtime (the default) can't access the filesystem.
export const runtime = "nodejs";

// Prefixes the middleware never intercepts. Either they're public, or the route
// handler itself runs Better Auth / agent bearer auth and returns a proper
// status (401/403/200) instead of a redirect to /signin.
const PASSTHROUGH_PREFIXES = [
	"/signin",
	"/api/",            // ALL API routes self-gate; middleware never redirects API
	"/s/",              // Public shared doc pages (auth handled by the page/api)
	"/_next",
	"/icon.svg",
	"/favicon.ico",
];

// Lite mode deny list: these routes are never available in lite deployments.
const LITE_DENY_PREFIXES = [
	"/api/system/",
	"/api/agent",
	"/api/agents",
	"/api/share",
	"/api/owner",
	"/api/auth",
	"/api/pdf",
	"/signin",
	"/s/",
];

export function middleware(req: NextRequest): NextResponse {
	const { pathname } = req.nextUrl;

	// Lite mode deny list evaluated before passthrough.
	if (process.env.WIKI_LITE === "1") {
		if (LITE_DENY_PREFIXES.some((p) => pathname.startsWith(p))) {
			return new NextResponse(null, { status: 404 });
		}
	}

	if (PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))) {
		return NextResponse.next();
	}

	// --no-auth: dev/CI only. Skips all auth. API routes still gate themselves
	// via requireUser() which also respects WIKI_NO_AUTH, so this makes the full
	// app work without any credentials.
	if (process.env.WIKI_NO_AUTH === "1") {
		return NextResponse.next();
	}

	// Cheap presence check; real session validation happens in individual routes.
	// Cookie name from better-auth default: "better-auth.session_token"
	const sessionCookie =
		req.cookies.get("better-auth.session_token") ??
		req.cookies.get("__Secure-better-auth.session_token");

	if (!sessionCookie) {
		const url = new URL("/signin", req.url);
		url.searchParams.set("next", pathname);
		return NextResponse.redirect(url);
	}

	return NextResponse.next();
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
