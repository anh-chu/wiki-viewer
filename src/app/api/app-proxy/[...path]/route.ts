/**
 * Reverse proxy for node-app directories.
 * URL format: /api/app-proxy/<relPath...>/<rest...>
 *
 * Resolves the running app by the longest-matching relPath prefix,
 * then forwards the request to http://localhost:{port}/{rest}.
 *
 * HTML:  injects <base> tag, rewrites absolute src/href attrs,
 *        and registers a service worker so JS fetch('/absolute')
 *        calls also flow through the proxy (fixes remote access).
 * CSS:   rewrites url(/...) patterns.
 * JS/bin: streamed as-is.
 *
 * Special path: …/sw-proxy.js — served locally (the service worker script).
 */
import { NextResponse } from "next/server";
import { resolveByPrefix } from "@/lib/app-runner";

const HOP_BY_HOP = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"te", "trailers", "transfer-encoding", "upgrade", "content-length",
]);

// ── service worker ────────────────────────────────────────────────────────────

function makeServiceWorker(proxyBase: string): string {
	return `
/* wiki-viewer injected service worker — proxies absolute-path fetches */
const BASE = ${JSON.stringify(proxyBase)};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only same-origin requests that don't already go through proxy
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(BASE + "/")) return;
  if (url.pathname === BASE + "/sw-proxy.js") return;

  const proxied = BASE + url.pathname + url.search;
  event.respondWith(
    fetch(proxied, {
      method:  event.request.method,
      headers: event.request.headers,
      body:    ["GET","HEAD"].includes(event.request.method) ? undefined : event.request.body,
      credentials: event.request.credentials,
    })
  );
});
`.trim();
}

// ── html / css rewriting ──────────────────────────────────────────────────────

function rewriteHtml(html: string, proxyBase: string): string {
	let out = html;
	// 1. Rewrite absolute src/href/action/data-* FIRST (skip protocol-relative //)
	//    Do this before injecting our own tags so our injections aren't re-rewritten.
	out = out.replace(
		/((?:src|href|action|data-src|data-href|content)=")\/(?!\/)/g,
		`$1${proxyBase}/`,
	);
	// 2. Rewrite srcset="/..." entries
	out = out.replace(/(srcset="[^"]*)\/(?!\/)/g, `$1${proxyBase}/`);
	// 3. Inject <base> after opening <head> tag (handles remaining relative URLs)
	out = out.replace(
		/(<head(?:\s[^>]*)?>)/i,
		`$1\n<base href="${proxyBase}/">`,
	);
	// 4. Inject SW registration before </head>
	const swScript = `<script>
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("${proxyBase}/sw-proxy.js", { scope: "${proxyBase}/" })
      .catch(function(e) { console.warn("[wiki-viewer proxy] SW:", e); });
  }
</script>`;
	out = out.replace(/<\/head>/i, `${swScript}\n</head>`);
	return out;
}

function rewriteCss(css: string, proxyBase: string): string {
	return css.replace(/url\((['"]?)\/(?!\/)/g, `url($1${proxyBase}/`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function forwardHeaders(src: Headers, port: number, reqUrl: URL): Headers {
	const out = new Headers();
	for (const [k, v] of src.entries()) {
		if (HOP_BY_HOP.has(k.toLowerCase())) continue;
		out.set(k, v);
	}
	out.set("host", `localhost:${port}`);
	out.set("x-forwarded-host", reqUrl.host);
	out.set("x-forwarded-proto", reqUrl.protocol.replace(":", ""));
	return out;
}

function rewriteResponseHeaders(src: Headers, proxyBase: string): Headers {
	const out = new Headers();
	for (const [k, v] of src.entries()) {
		if (HOP_BY_HOP.has(k.toLowerCase())) continue;
		if (k.toLowerCase() === "location" && v.startsWith("/") && !v.startsWith("//")) {
			out.set(k, proxyBase + v);
			continue;
		}
		out.set(k, v);
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

	// Special: serve the injected service worker script
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

	const upstream = `http://localhost:${port}${rest}${reqUrl.search}`;

	let upstreamRes: Response;
	try {
		upstreamRes = await fetch(upstream, {
			method: request.method,
			headers: forwardHeaders(request.headers, port, reqUrl),
			body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
			// @ts-expect-error — Node.js fetch needs duplex for request body streaming
			duplex: "half",
			redirect: "manual",
		});
	} catch (e) {
		return NextResponse.json({ error: `Upstream unreachable: ${e}` }, { status: 502 });
	}

	const contentType = upstreamRes.headers.get("content-type") ?? "";
	const resHeaders = rewriteResponseHeaders(upstreamRes.headers, proxyBase);

	if (contentType.includes("text/html")) {
		const rewritten = rewriteHtml(await upstreamRes.text(), proxyBase);
		resHeaders.set("content-type", "text/html; charset=utf-8");
		return new Response(rewritten, { status: upstreamRes.status, headers: resHeaders });
	}

	if (contentType.includes("text/css")) {
		const rewritten = rewriteCss(await upstreamRes.text(), proxyBase);
		resHeaders.set("content-type", contentType);
		return new Response(rewritten, { status: upstreamRes.status, headers: resHeaders });
	}

	// Stream JS, images, fonts, JSON, etc. as-is
	return new Response(upstreamRes.body, { status: upstreamRes.status, headers: resHeaders });
}

export const GET = handleProxy;
export const POST = handleProxy;
export const PUT = handleProxy;
export const DELETE = handleProxy;
export const PATCH = handleProxy;
export const HEAD = handleProxy;
export const OPTIONS = handleProxy;
export const dynamic = "force-dynamic";
