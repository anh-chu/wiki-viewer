/**
 * Reusable request-forwarding core for node-app reverse proxying.
 *
 * Extracted from the original /api/app-proxy route so that BOTH the legacy
 * proxy path (`/api/app-proxy/<relPath>/…`) and the Hosted Apps slug route
 * (`/app/<slug>/…`) share one implementation of:
 *   - HTML/CSS URL rewriting (root-absolute → proxy-prefixed)
 *   - SPA fallback (client-route 404 → index.html)
 *   - service-worker bootstrap for Vite-dev module graphs
 *   - hop-by-hop / credential header stripping
 *
 * The caller supplies `proxyBase` (the public path prefix under which the app
 * is reached) and `port` (resolved fresh per request — never baked in). This is
 * what lets an already-open client survive an app restart on a new port: the
 * slug never changes, only the port the caller looks up each time.
 *
 * Built on undici.request() rather than fetch(): undici does NOT auto-decompress,
 * so compressed assets stream through with Content-Encoding intact (no
 * ERR_CONTENT_DECODING_FAILED). For HTML/CSS we force accept-encoding:identity
 * upstream so we always receive plain text we can safely rewrite.
 */
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import type { Dispatcher } from "undici";

const HOP_BY_HOP = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailers", "transfer-encoding", "upgrade",
]);

// Wiki credentials that must never be forwarded to an untrusted child app.
const STRIP_UPSTREAM = new Set([
	"cookie",
	"authorization",
	"x-agent-id",
	"x-workspace",
	"origin",
]);

// ── service worker ────────────────────────────────────────────────────────────

function makeServiceWorker(proxyBase: string): string {
	return `
/* wiki-viewer injected service worker */
const BASE = ${JSON.stringify(proxyBase)};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(BASE + "/")) return;
  if (url.pathname === BASE + "/sw-proxy.js") return;
  event.respondWith(fetch(BASE + url.pathname + url.search, {
    method: event.request.method,
    headers: event.request.headers,
    body: ["GET","HEAD"].includes(event.request.method) ? undefined : event.request.body,
    credentials: event.request.credentials,
  }));
});`.trim();
}

// ── rewriters ─────────────────────────────────────────────────────────────────

// Vite dev emits root-absolute ES-module imports (/@vite/client, /@react-refresh,
// /@fs/...) inside <script> bodies and transformed JS. Those bypass <base href>
// and the HTML/CSS rewriters, so they hit the origin root and 404 → white screen.
// The injected service worker reroutes them under the proxy prefix, but it can't
// catch the FIRST load (modules fetch before the SW controls the page). This
// bootstrap closes that race: serve it as the first document, register the SW,
// wait until it actually controls, then reload — so the real app HTML (and its
// whole module graph) only loads once the SW is in charge.
const SW_READY_COOKIE = "wv_sw_ready";

function viteDevMarkers(html: string): boolean {
	return /\/@vite\/client|\/@react-refresh|\/@fs\//.test(html);
}

function isDocumentNav(request: Request): boolean {
	const dest = request.headers.get("sec-fetch-dest");
	if (dest) return dest === "document";
	return (request.headers.get("accept") ?? "").includes("text/html");
}

function bootstrapHtml(proxyBase: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>Loading…</title></head>
<body>
<script>
(function(){
  var BASE = ${JSON.stringify(proxyBase)};
  function go(){ document.cookie = ${JSON.stringify(SW_READY_COOKIE)} + "=1;path=" + BASE + "/"; location.reload(); }
  if (!('serviceWorker' in navigator)) { go(); return; } // no SW (plain HTTP) → best-effort
  navigator.serviceWorker.register(BASE + '/sw-proxy.js?v=2', { scope: BASE + '/' }).then(function(){
    if (navigator.serviceWorker.controller) { go(); return; }
    navigator.serviceWorker.addEventListener('controllerchange', function(){ go(); }, { once: true });
    setTimeout(function(){ go(); }, 4000); // safety: never hang on the bootstrap
  }).catch(go);
})();
</script>
</body></html>`;
}

// Returns a bootstrap Response when this is the first document load of a Vite-dev
// app (SW not yet known to control), else null to serve the real HTML.
function maybeBootstrap(html: string, request: Request, proxyBase: string): Response | null {
	if (!isDocumentNav(request) || !viteDevMarkers(html)) return null;
	if ((request.headers.get("cookie") ?? "").includes(`${SW_READY_COOKIE}=1`)) return null;
	return new Response(bootstrapHtml(proxyBase), {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

function rewriteHtml(html: string, proxyBase: string): string {
	let out = html;
	out = out.replace(/((?:src|href|action|data-src|data-href|content)=")\/(?!\/)/g, `$1${proxyBase}/`);
	out = out.replace(/(srcset="[^"]*)\/(?!\/)/g, `$1${proxyBase}/`);
	out = out.replace(/(<head(?:\s[^>]*)?>)/i, `$1\n<base href="${proxyBase}/">`);
	// Inject before </head>. Works without service workers (non-localhost HTTP):
	//
	// The proxy prefix (/app/<slug>) is the app's REAL public URL and must stay
	// in the address bar so reloads and shared links keep working. We therefore do
	// NOT rewrite the URL to the child's root. Instead we expose the base path so a
	// client router can adopt it as its basename, and rewrite root-absolute network
	// calls back through the proxy.
	//
	// 1. window.__WIKI_APP_BASE__ — the base path apps should use as router basename
	// 2. fetch/XHR overrides — rewrite absolute-path calls (/api/...) through
	//    the proxy so they reach the upstream app, not wiki-viewer
	// 3. SW — best-effort (only works on localhost/HTTPS), provides navigation
	//    interception for hard-refreshes on sub-routes
	const patches = `<script>
(function(){
  var BASE = ${JSON.stringify(proxyBase)};
  // 1. Expose the base path; the proxy prefix stays in the URL bar so /app/<slug>
  //    remains the real, reloadable app URL.
  window.__WIKI_APP_BASE__ = BASE;
  // 2. Rewrite fetch() absolute paths through proxy (works on non-localhost HTTP)
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('/') && !input.startsWith(BASE + '/')) {
      input = BASE + input;
    }
    return _fetch.call(window, input, init);
  };
  // 3. Rewrite XMLHttpRequest absolute paths
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(BASE + '/')) {
      url = BASE + url;
    }
    return _xhrOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
  // 4. SW — best-effort for localhost/HTTPS; reloads once on first activation
  if ('serviceWorker' in navigator) {
    if (!navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener('controllerchange', function() {
        window.location.reload();
      }, { once: true });
    }
    navigator.serviceWorker.register(BASE + '/sw-proxy.js?v=2', { scope: BASE + '/' })
      .catch(function(){});
  }
})();
</script>`;
	out = out.replace(/<\/head>/i, `${patches}\n</head>`);
	return out;
}

function rewriteCss(css: string, proxyBase: string): string {
	return css.replace(/url\((['"]?)\/(?!\/)/g, `url($1${proxyBase}/`);
}

// Redirect Location headers from the child are relative to the child's own root,
// not the public proxy path. Left untouched, `Location: /foo` sends the browser
// to the wiki-viewer root (dropping the /app/<slug> prefix) and
// `Location: http://localhost:<port>/foo` points at the private child port.
// Rewrite both back under proxyBase so reloads and app-issued redirects stay on
// the app's real public URL.
function rewriteLocation(loc: string, proxyBase: string, port: number): string {
	try {
		const u = new URL(loc);
		// Absolute URL aimed at the private child → swap origin for the proxy path.
		if (u.hostname === "localhost" && String(u.port) === String(port)) {
			return `${proxyBase}${u.pathname}${u.search}${u.hash}`;
		}
		// Any other absolute URL is genuinely external; leave it alone.
		return loc;
	} catch {
		// Not an absolute URL — fall through to relative handling.
	}
	// Root-absolute path (but not protocol-relative //host, and not already prefixed).
	if (loc.startsWith("/") && !loc.startsWith("//") && loc !== proxyBase && !loc.startsWith(`${proxyBase}/`)) {
		return `${proxyBase}${loc}`;
	}
	return loc;
}

// ── header helpers ────────────────────────────────────────────────────────────

function upstreamHeaders(
	src: Headers,
	port: number,
	reqUrl: URL,
	forceIdentity = false,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of src.entries()) {
		const kl = k.toLowerCase();
		if (HOP_BY_HOP.has(kl)) continue;
		if (STRIP_UPSTREAM.has(kl)) continue;
		out[k] = v;
	}
	out["host"] = `localhost:${port}`;
	out["x-forwarded-host"] = reqUrl.host;
	out["x-forwarded-proto"] = reqUrl.protocol.replace(":", "");
	if (forceIdentity) out["accept-encoding"] = "identity";
	return out;
}

function buildResHeaders(
	raw: Dispatcher.ResponseData["headers"],
	proxyBase: string,
	port: number,
): Headers {
	const out = new Headers();
	for (const [k, v] of Object.entries(raw)) {
		if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
		const kl = k.toLowerCase();
		const vals = Array.isArray(v) ? v : [v];
		for (const val of vals) {
			out.append(k, kl === "location" ? rewriteLocation(val, proxyBase, port) : val);
		}
	}
	return out;
}

// ── core ──────────────────────────────────────────────────────────────────────

export interface ForwardTarget {
	/** Upstream child port. Resolve this fresh per request; never bake it in. */
	port: number;
	/** Upstream path (leading slash), already stripped of the proxy prefix. */
	rest: string;
	/** Public path prefix the app is reached under (no trailing slash). */
	proxyBase: string;
}

/**
 * Forward an incoming request to the running child at `target.port`, applying
 * HTML/CSS rewriting, SPA fallback, and the SW bootstrap keyed on
 * `target.proxyBase`. Serves the injected service worker at
 * `<proxyBase>/sw-proxy.js`.
 */
export async function forwardToChild(request: Request, target: ForwardTarget): Promise<Response> {
	const { port, rest, proxyBase } = target;
	const reqUrl = new URL(request.url);

	if (rest === "/sw-proxy.js") {
		return new Response(makeServiceWorker(proxyBase), {
			status: 200,
			headers: {
				"content-type": "application/javascript; charset=utf-8",
				"service-worker-allowed": proxyBase + "/",
				"cache-control": "no-store",
			},
		});
	}

	const upstreamUrl = `http://localhost:${port}${rest}${reqUrl.search}`;
	const method = request.method as Dispatcher.HttpMethod;
	const isBodyless = ["GET", "HEAD"].includes(request.method);

	try {
		// First pass with normal headers to discover content-type
		const first = await undiciRequest(upstreamUrl, {
			method,
			headers: upstreamHeaders(request.headers, port, reqUrl),
			body: isBodyless ? null : (request.body as unknown as Readable),
		});

		const contentType = String(first.headers["content-type"] ?? "");
		const needsRewrite = contentType.includes("text/html") || contentType.includes("text/css");

		if (needsRewrite) {
			// Drain first response and re-fetch with identity encoding for plain text
			first.body.resume();
			const second = await undiciRequest(upstreamUrl, {
				method: isBodyless ? method : "GET",
				headers: upstreamHeaders(request.headers, port, reqUrl, true),
				body: null,
			});
			const text = await second.body.text();
			const resHeaders = buildResHeaders(second.headers, proxyBase, port);
			// Body changed size after rewriting — drop these or client truncates
			resHeaders.delete("content-encoding");
			resHeaders.delete("content-length");

			if (contentType.includes("text/html")) {
				resHeaders.set("content-type", "text/html; charset=utf-8");
				return maybeBootstrap(text, request, proxyBase)
					?? new Response(rewriteHtml(text, proxyBase), { status: second.statusCode, headers: resHeaders });
			}
			resHeaders.set("content-type", contentType);
			return new Response(rewriteCss(text, proxyBase), { status: second.statusCode, headers: resHeaders });
		}

		// SPA fallback: if upstream returns 404 for a path with no file extension
		// (i.e. a client-side route), re-fetch "/" and return index.html so the
		// SPA's router can handle it client-side.
		const hasExt = /\.[a-z0-9]{1,8}$/i.test(rest.split("?")[0]);
		if (first.statusCode === 404 && !hasExt) {
			first.body.resume();
			const fallback = await undiciRequest(`http://localhost:${port}/`, {
				method: "GET",
				headers: upstreamHeaders(request.headers, port, reqUrl, true),
				body: null,
			});
			const fallbackText = await fallback.body.text();
			const fallbackHeaders = buildResHeaders(fallback.headers, proxyBase, port);
			fallbackHeaders.delete("content-encoding");
			fallbackHeaders.delete("content-length");
			fallbackHeaders.set("content-type", "text/html; charset=utf-8");
			return maybeBootstrap(fallbackText, request, proxyBase) ?? new Response(rewriteHtml(fallbackText, proxyBase), {
				status: 200,
				headers: fallbackHeaders,
			});
		}

		// 304/204/205: null-body statuses — Response constructor rejects a stream body
		if (new Set([101, 204, 205, 304]).has(first.statusCode)) {
			first.body.resume();
			return new Response(null, {
				status: first.statusCode,
				headers: buildResHeaders(first.headers, proxyBase, port),
			});
		}

		// Stream everything else — compressed bytes + Content-Encoding flow through intact
		return new Response(Readable.toWeb(first.body) as ReadableStream, {
			status: first.statusCode,
			headers: buildResHeaders(first.headers, proxyBase, port),
		});
	} catch (e) {
		const { NextResponse } = await import("next/server");
		return NextResponse.json({ error: `Upstream unreachable: ${e}` }, { status: 502 });
	}
}
