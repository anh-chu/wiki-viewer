import { NextResponse, type NextRequest } from "next/server";

// Prefixes the middleware never intercepts. Either they're public, or the route
// handler itself runs Better Auth / agent bearer auth and returns a proper
// status (401/403/200) instead of a redirect to /signin.
const PASSTHROUGH_PREFIXES = [
	"/signin",
	"/api/",            // ALL API routes self-gate; middleware never redirects API
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
