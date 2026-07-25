import { NextResponse, type NextRequest } from "next/server";
import { validateApiKey } from "./lib/auth/api-key";
import { validateRootParam } from "./lib/embed-root";

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

// When a valid api_key is present the key itself is the authorization boundary.
// frame-ancestors * just tells browsers the embedding is server-approved.
// Without a valid key the embed bypass doesn't fire and X-Frame-Options: SAMEORIGIN applies.
const CSP_FRAME_ANCESTORS = "frame-ancestors *";

export function middleware(req: NextRequest): NextResponse {
	const { pathname } = req.nextUrl;

	if (PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))) {
		return NextResponse.next();
	}

	// --no-auth: dev/CI only. Skips all auth. API routes still gate themselves
	// via requireUser() which also respects WIKI_NO_AUTH, so this makes the full
	// app work without any credentials.
	if (process.env.WIKI_NO_AUTH === "1") {
		return NextResponse.next();
	}

	// Embed mode: allow iframe framing from localhost when a valid API key is
	// presented. The key is auto-generated at ~/.wiki-viewer/api-key on first
	// startup and read by termyard's Go backend.
	//
	// On initial iframe load (?embed=1&api_key=<key>): validate key, set an
	// HttpOnly session cookie so the iframe's same-origin API calls are
	// authenticated automatically (browsers don't send custom headers on
	// same-origin fetch from an iframe, but they do send cookies).
	//
	// On subsequent navigations (?embed=1 without api_key): cookie already set,
	// validate via cookie.
	const isEmbed = req.nextUrl.searchParams.get("embed") === "1";
	if (isEmbed) {
		const apiKeyParam = req.nextUrl.searchParams.get("api_key") ?? "";
		const embedCookieValue =
			req.cookies.get("__wiki_embed_auth")?.value ?? "";

		const keyToCheck = apiKeyParam || embedCookieValue;
		if (keyToCheck && validateApiKey(keyToCheck)) {
			// Validate ?root= HERE, not just in the API routes.
			//
			// The iframe's initial load is a page navigation, so without this a bad
			// root renders the normal shell with HTTP 200 and the embedding host
			// concludes all is well — the 400 only materializes later from an
			// in-iframe fetch the host cannot observe cross-origin. That is the
			// exact silent failure this feature exists to remove, one layer down.
			//
			// Ordering matters: this runs only AFTER the key has validated, so it
			// can't be used as a filesystem-existence oracle by an unauthenticated
			// caller. Same codes as the API routes (shared validateRootParam).
			const rootParam = req.nextUrl.searchParams.get("root");
			if (rootParam) {
				const valid = validateRootParam(rootParam);
				if (!valid.ok) {
					return NextResponse.json(
						{ error: valid.code },
						{
							status: 400,
							headers: {
								// Readable without parsing the body, for hosts that only
								// inspect headers on a navigation probe.
								"X-Wiki-Error": valid.code,
								"Cache-Control": "no-store",
							},
						},
					);
				}
			}

			const res = NextResponse.next();
			res.headers.set("Content-Security-Policy", CSP_FRAME_ANCESTORS);
			// Set / refresh the embed auth cookie whenever the api_key param is
			// present (initial load or explicit re-auth).
			if (apiKeyParam) {
				res.cookies.set("__wiki_embed_auth", apiKeyParam, {
					httpOnly: true,
					sameSite: "strict",
					path: "/",
					// No maxAge → session cookie (cleared when browser/tab closes)
				});
			}
			return res;
		}
		// Key absent or invalid → fall through to cookie / signin check below.
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
