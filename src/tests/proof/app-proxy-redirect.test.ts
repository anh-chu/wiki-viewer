/**
 * Proxy redirect rewriting (Hosted Apps node branch).
 *
 * A child app issues redirects relative to its OWN root (`Location: /foo`) or,
 * less often, as an absolute URL to its private port. Neither is valid on the
 * public `/app/<slug>` path: the former drops the slug prefix (landing on the
 * wiki-viewer root), the latter points at an unreachable localhost port.
 * forwardToChild must rewrite both back under proxyBase, while leaving genuinely
 * external redirects and already-prefixed paths untouched.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { forwardToChild } from "../../lib/app-proxy-core.js";

async function withUpstream(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	fn: (port: number) => Promise<void>,
): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await fn(port);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

const PROXY_BASE = "/app/myapp";

async function locationFor(port: number, location: string, rest = "/"): Promise<string | null> {
	const req = new Request(`http://wiki.example${PROXY_BASE}${rest === "/" ? "" : rest}`);
	const res = await forwardToChild(req, { port, rest, proxyBase: PROXY_BASE });
	assert.equal(res.status, 302);
	return res.headers.get("location");
}

test("root-absolute redirect is prefixed with proxyBase", async () => {
	await withUpstream(
		(_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "/dashboard?tab=1");
			res.end();
		},
		async (port) => {
			assert.equal(await locationFor(port, "/dashboard?tab=1"), `${PROXY_BASE}/dashboard?tab=1`);
		},
	);
});

test("absolute redirect to the child's own port is rewritten to proxyBase", async () => {
	await withUpstream(
		(req, res) => {
			const port = (req.socket.localPort ?? 0) as number;
			res.statusCode = 302;
			res.setHeader("location", `http://localhost:${port}/foo`);
			res.end();
		},
		async (port) => {
			assert.equal(await locationFor(port, "ignored"), `${PROXY_BASE}/foo`);
		},
	);
});

test("already-prefixed redirect is not double-prefixed", async () => {
	await withUpstream(
		(_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", `${PROXY_BASE}/already`);
			res.end();
		},
		async (port) => {
			assert.equal(await locationFor(port, "x"), `${PROXY_BASE}/already`);
		},
	);
});

test("external redirect is left untouched", async () => {
	await withUpstream(
		(_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "https://accounts.google.com/o/oauth2/auth");
			res.end();
		},
		async (port) => {
			assert.equal(await locationFor(port, "y"), "https://accounts.google.com/o/oauth2/auth");
		},
	);
});

test("HTML keeps the proxy prefix in the URL (no replaceState strip) and rewrites links", async () => {
	await withUpstream(
		(_req, res) => {
			res.statusCode = 200;
			res.setHeader("content-type", "text/html");
			res.end(`<!doctype html><html><head><title>t</title></head><body><a href="/dashboard">go</a></body></html>`);
		},
		async (port) => {
			const req = new Request(`http://wiki.example${PROXY_BASE}`, {
				headers: { accept: "text/html" },
			});
			const res = await forwardToChild(req, { port, rest: "/", proxyBase: PROXY_BASE });
			const html = await res.text();
			// The prefix must NOT be stripped from the address bar.
			assert.ok(!html.includes("history.replaceState"), "must not strip the proxy prefix");
			// Base path is exposed for client routers to adopt as basename.
			assert.match(html, /window\.__WIKI_APP_BASE__ = BASE/);
			assert.match(html, /var BASE = "\/app\/myapp"/);
			// Resources resolve under the prefix.
			assert.match(html, /<base href="\/app\/myapp\/">/);
			// Root-absolute links are prefixed.
			assert.match(html, /href="\/app\/myapp\/dashboard"/);
		},
	);
});
