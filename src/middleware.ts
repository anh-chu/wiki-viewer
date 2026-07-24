import { NextResponse, type NextRequest } from "next/server";

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

export function middleware(req: NextRequest): NextResponse {
	const { pathname } = req.nextUrl;

	if (PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))) {
		return NextResponse.next();
	}

	// --no-auth skip
	if (process.env.WIKI_NO_AUTH === "1") {
		return NextResponse.next();
	}

	// Embed mode: allow iframe framing from localhost; set frame-ancestors CSP and
	// skip the cookie redirect so the page HTML loads. WIKI_NO_AUTH=1 is still
	// required — API routes gate themselves with getSession() and the iframe
	// context has no cross-origin session cookie regardless of this bypass.
	//
	// Browsers do NOT send Origin on iframe GET navigations (only on fetch/XHR),
	// so we check both: Origin (for subsequent in-iframe fetches, though those hit
	// /api/ which is a passthrough) and Sec-Fetch-Dest (for the initial navigation).
	// Sec-Fetch-Site same-site/same-origin excludes cross-site frames (evil.com→localhost).
	const isEmbed = req.nextUrl.searchParams.get("embed") === "1";
	const origin    = req.headers.get("origin") ?? "";
	const fetchDest = req.headers.get("sec-fetch-dest");
	const fetchSite = req.headers.get("sec-fetch-site");
	const originOk  = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
	const iframeFromLocalhost =
		fetchDest === "iframe" &&
		(fetchSite === "same-site" || fetchSite === "same-origin");
	if (isEmbed && (originOk || iframeFromLocalhost)) {
		const res = NextResponse.next();
		res.headers.set(
			"Content-Security-Policy",
			"frame-ancestors http://localhost:* https://localhost:* http://127.0.0.1:* https://127.0.0.1:*",
		);
		return res;
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
