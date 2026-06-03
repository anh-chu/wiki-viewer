/**
 * Latency-model benchmark: proves how per-call TCP/TLS handshakes (no keep-alive)
 * vs pooled keep-alive connections behave under WAN-like RTT.
 *
 * It does NOT need the full Next server — it runs a tiny local HTTP server that
 * sleeps RTT/2 before responding (modeling one-way latency), then compares:
 *   A) fetch with a fresh connection each call (no keep-alive)
 *   B) fetch over a pooled keep-alive agent (undici)
 *
 * For each, it models a "write" (1 request) and an "edit" (2 requests: GET+PUT).
 *
 * Run: node packages/wiki-viewer-mcp/bench-latency.mjs [rttMs]
 */
import http from "node:http";
import { Agent, fetch as undiciFetch } from "undici";

const RTT = Number(process.argv[2] ?? process.env.RTT_MS ?? 80); // round-trip ms
const ITERS = Number(process.env.ITERS ?? 30);
const ONE_WAY = RTT / 2;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Local server that injects one-way latency on both receive and send.
const server = http.createServer(async (req, res) => {
	// drain body
	for await (const _ of req) { /* consume */ }
	await sleep(ONE_WAY);           // network: client -> server
	res.writeHead(200, { "Content-Type": "application/json", ETag: '"sha256:abc"', "X-File-Size": "1024" });
	res.end(JSON.stringify({ sha256: "sha256:abc", size: 1024 }));
});

function pct(s, p) { return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function summarize(label, samples) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return `${label.padEnd(40)} p50=${pct(s, 50).toFixed(0)}ms  p95=${pct(s, 95).toFixed(0)}ms  mean=${mean.toFixed(0)}ms`;
}

async function bench(label, doCall) {
	const samples = [];
	for (let i = 0; i < ITERS + 5; i++) {
		const t = performance.now();
		await doCall();
		if (i >= 5) samples.push(performance.now() - t);
	}
	return summarize(label, samples);
}

async function main() {
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const base = `http://127.0.0.1:${port}/x`;

	// A) No keep-alive: force a fresh connection per request.
	const noKa = new Agent({ pipelining: 0, connections: 1, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
	// B) Pooled keep-alive.
	const ka = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 10 });

	const req = (dispatcher, method) =>
		undiciFetch(base, { method, dispatcher, headers: { "content-type": "application/octet-stream" }, body: method === "PUT" ? "x".repeat(1024) : undefined })
			.then((r) => r.arrayBuffer());

	// Model a COLD connection: TCP(1 RTT) + TLS(≈2 RTT) handshake before the
	// request even goes out. Real HTTPS over WAN pays this on every call when
	// the client doesn't reuse connections. We add it explicitly because
	// loopback can't reproduce handshake cost.
	const HANDSHAKE_RTTS = Number(process.env.HANDSHAKE_RTTS ?? 3); // TCP+TLS ≈ 3 RTT
	const freshReq = async (method) => {
		await sleep(HANDSHAKE_RTTS * RTT); // cold-connection handshake penalty
		const d = new Agent({ keepAliveTimeout: 1, connections: 1 });
		await req(d, method);
		await d.close();
	};

	console.log(`\nlatency model — RTT=${RTT}ms, iters=${ITERS}\n`);
	console.log(await bench("write  · fresh conn per call (no keep-alive)", () => freshReq("PUT")));
	console.log(await bench("write  · pooled keep-alive", () => req(ka, "PUT")));
	console.log(await bench("edit   · fresh conn per call (GET+PUT)", async () => { await freshReq("GET"); await freshReq("PUT"); }));
	console.log(await bench("edit   · pooled keep-alive (GET+PUT)", async () => { await req(ka, "GET"); await req(ka, "PUT"); }));
	console.log("");
	console.log("Note: 'fresh conn' pays TCP handshake (+~1 RTT) per call; real HTTPS adds TLS (+1-2 RTT).");
	console.log("");

	await noKa.close(); await ka.close();
	server.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
