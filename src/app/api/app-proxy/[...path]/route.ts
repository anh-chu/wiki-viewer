/**
 * Reverse proxy for node-app directories — built on undici.request()
 *
 * Unlike fetch(), undici.request() does NOT auto-decompress, so compressed
 * assets (gzip/br) stream through with their Content-Encoding intact and the
 * browser handles decompression itself. No ERR_CONTENT_DECODING_FAILED.
 *
 * For HTML/CSS (which we rewrite) we force accept-encoding:identity upstream
 * so we always receive plain text we can safely manipulate.
 */
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import type { Dispatcher } from "undici";
import { NextResponse } from "next/server";
import { resolveByPrefix } from "@/lib/app-runner";

const HOP_BY_HOP = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailers", "transfer-encoding", "upgrade",
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

function rewriteHtml(html: string, proxyBase: string): string {
	let out = html;
	out = out.replace(/((?:src|href|action|data-src|data-href|content)=")\/(?!\/)/g, `$1${proxyBase}/`);
	out = out.replace(/(srcset="[^"]*)\/(?!\/)/g, `$1${proxyBase}/`);
	out = out.replace(/(<head(?:\s[^>]*)?>)/i, `$1\n<base href="${proxyBase}/">`);
	// Inject before </head>:
	// 1. Router patch — makes BrowserRouter (and any code reading window.location.pathname)
	//    see the path WITHOUT the proxy prefix, so routes like "/" and "/s/:id" match.
	//    history.push/replaceState is also patched to re-add the prefix so the SW can
	//    intercept subsequent navigations.
	// 2. SW registration — reloads once on first activation so the SW controls the page
	//    before the user clicks any link.
	const patches = `<script>
(function(){
  var BASE = ${JSON.stringify(proxyBase)};
  // Strip proxy prefix from Location.prototype.pathname so SPAs with BrowserRouter work
  try {
    var _desc = Object.getOwnPropertyDescriptor(Location.prototype, "pathname");
    Object.defineProperty(Location.prototype, "pathname", {
      get: function() {
        var p = _desc.get.call(this);
        return p.startsWith(BASE) ? (p.slice(BASE.length) || "/") : p;
      }, configurable: true
    });
  } catch(e) {}
  // Prefix pushState/replaceState so navigated URLs stay inside the proxy scope
  // (allows the SW to intercept them on reload/refresh)
  var _push = history.pushState.bind(history);
  var _replace = history.replaceState.bind(history);
  function pfx(u) {
    return (typeof u === "string" && u && u[0] === "/" && !u.startsWith(BASE)) ? BASE + u : u;
  }
  history.pushState    = function(s,t,u){ return _push(s,t,pfx(u));    };
  history.replaceState = function(s,t,u){ return _replace(s,t,pfx(u)); };
  // SW registration — reload once on first activation so SW controls the page
  // before any JS fetch() call is made. Uses controllerchange which fires when
  // clients.claim() runs inside the SW, regardless of skipWaiting timing.
  if ("serviceWorker" in navigator) {
    if (!navigator.serviceWorker.controller) {
      navigator.serviceWorker.addEventListener("controllerchange", function() {
        window.location.reload();
      }, { once: true });
    }
    navigator.serviceWorker.register(BASE + "/sw-proxy.js?v=2", { scope: BASE + "/" })
      .catch(function(e){ console.warn("[wiki-viewer proxy] SW:", e); });
  }
})();
</script>`;
	out = out.replace(/<\/head>/i, `${patches}\n</head>`);
	return out;
}

function rewriteCss(css: string, proxyBase: string): string {
	return css.replace(/url\((['"]?)\/(?!\/)/g, `url($1${proxyBase}/`);
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
		if (HOP_BY_HOP.has(k.toLowerCase())) continue;
		out[k] = v;
	}
	out["host"] = `localhost:${port}`;
	out["x-forwarded-host"] = reqUrl.host;
	out["x-forwarded-proto"] = reqUrl.protocol.replace(":", "");
	if (forceIdentity) out["accept-encoding"] = "identity";
	return out;
}

function buildResHeaders(raw: Dispatcher.ResponseData["headers"]): Headers {
	const out = new Headers();
	for (const [k, v] of Object.entries(raw)) {
		if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
		const vals = Array.isArray(v) ? v : [v];
		for (const val of vals) out.append(k, val);
	}
	return out;
}

// ── handler ───────────────────────────────────────────────────────────────────

async function handleProxy(
	request: Request,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
	const segments = (await params).path ?? [];
	const reqUrl = new URL(request.url);

	const resolved = resolveByPrefix(segments);
	if (!resolved) {
		return NextResponse.json(
			{ error: "App not running — launch it first in wiki-viewer." },
			{ status: 503 },
		);
	}

	const { port, relPath, rest } = resolved;
	const proxyBase = `/api/app-proxy/${relPath}`;

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
			const resHeaders = buildResHeaders(second.headers);
			// Body changed size after rewriting — drop these or client truncates
			resHeaders.delete("content-encoding");
			resHeaders.delete("content-length");

			if (contentType.includes("text/html")) {
				resHeaders.set("content-type", "text/html; charset=utf-8");
				return new Response(rewriteHtml(text, proxyBase), { status: second.statusCode, headers: resHeaders });
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
			const fallbackHeaders = buildResHeaders(fallback.headers);
			fallbackHeaders.delete("content-encoding");
			fallbackHeaders.delete("content-length");
			fallbackHeaders.set("content-type", "text/html; charset=utf-8");
			return new Response(rewriteHtml(fallbackText, proxyBase), {
				status: 200,
				headers: fallbackHeaders,
			});
		}

		// 304/204/205: null-body statuses — Response constructor rejects a stream body
		if (new Set([101, 204, 205, 304]).has(first.statusCode)) {
			first.body.resume();
			return new Response(null, { status: first.statusCode, headers: buildResHeaders(first.headers) });
		}

		// Stream everything else — compressed bytes + Content-Encoding flow through intact
		return new Response(Readable.toWeb(first.body) as ReadableStream, {
			status: first.statusCode,
			headers: buildResHeaders(first.headers),
		});

	} catch (e) {
		return NextResponse.json({ error: `Upstream unreachable: ${e}` }, { status: 502 });
	}
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const DELETE = handleProxy;
export const PATCH = handleProxy;
export const HEAD = handleProxy;
export const OPTIONS = handleProxy;
export const dynamic = "force-dynamic";
