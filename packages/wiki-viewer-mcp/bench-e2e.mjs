/**
 * End-to-end MCP benchmark — measures the FULL stack a remote agent crosses,
 * minus the LLM: MCP stdio JSON-RPC -> shim fetch (keep-alive or not) -> HTTP
 * -> Next standalone server -> route handler -> disk.
 *
 * It spawns the real Next standalone server on a loopback port with an
 * isolated temp ROOT_DIR + temp HOME (seeded agent registry), then drives the
 * REAL wiki-viewer-mcp shim over stdio via the MCP SDK client.
 *
 * Run from repo root:
 *   node packages/wiki-viewer-mcp/bench-e2e.mjs
 * Requires: `npm run build` (root) and shim built (npm --prefix packages/wiki-viewer-mcp run build).
 * Env: BENCH_ITERS (default 50), BENCH_WARMUP (default 10), BENCH_URL (skip spawning, hit a remote instance)
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ITERS = Number(process.env.BENCH_ITERS) || 50;
const WARMUP = Number(process.env.BENCH_WARMUP) || 10;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

function sha256hex(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
function pct(s, p) { return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function stats(label, samples) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = s.reduce((a, b) => a + b, 0) / s.length;
	return { label, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), mean, max: s[s.length - 1] };
}
async function timeIt(fn) { const t = performance.now(); await fn(); return performance.now() - t; }

function waitForLog(child, re, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const to = setTimeout(() => reject(new Error("server start timeout")), timeoutMs);
		const onData = (d) => {
			const s = d.toString();
			if (re.test(s)) { clearTimeout(to); child.stdout.off("data", onData); child.stderr.off("data", onData); resolve(); }
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
	});
}

async function main() {
	let serverProc = null;
	let baseUrl = process.env.BENCH_URL;
	let tmpHome, tmpRoot;
	const TOKEN = randomBytes(32).toString("hex");
	const AGENT_ID = "ai:bench";

	if (!baseUrl) {
		const PORT = 3917;
		tmpHome = await mkdtemp(path.join(tmpdir(), "bench-e2e-home-"));
		tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-e2e-root-"));
		// Seed registry: ~/.wiki-viewer/agents.json with our agent + hashed token
		const tokenHash = sha256hex(TOKEN);
		await mkdir(path.join(tmpHome, ".wiki-viewer"), { recursive: true });
		const now = new Date().toISOString();
		await writeFile(
			path.join(tmpHome, ".wiki-viewer", "agents.json"),
			JSON.stringify({
				version: 1,
				agents: {
					[AGENT_ID]: {
						id: AGENT_ID, displayName: "Bench", tokenHash,
						scope: { paths: ["**/*"], ops: ["read", "mutate", "delete"] },
						createdAt: now, lastSeen: now,
					},
				},
			}, null, 2),
			{ mode: 0o600 },
		);
		await writeFile(path.join(tmpRoot, "bench.md"), "# Doc\n\n" + "lorem ipsum dolor sit amet. ".repeat(40));

		serverProc = spawn("node", [path.join(REPO, ".next/standalone/server.js")], {
			env: {
				...process.env,
				HOME: tmpHome,
				ROOT_DIR: tmpRoot,
				PORT: String(PORT),
				HOSTNAME: "127.0.0.1",
				WIKI_ALLOW_INSECURE: "1",
				NODE_ENV: "production",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitForLog(serverProc, /Ready|started server|Listening|localhost:|127\.0\.0\.1:/i);
		baseUrl = `http://127.0.0.1:${PORT}`;
		// settle
		await new Promise((r) => setTimeout(r, 500));
	}

	// Drive the REAL shim over stdio
	const transport = new StdioClientTransport({
		command: "node",
		args: [path.join(HERE, "dist/index.js")],
		env: {
			...process.env,
			WIKI_VIEWER_URL: baseUrl,
			WIKI_VIEWER_TOKEN: TOKEN,
			WIKI_VIEWER_AGENT_ID: AGENT_ID,
		},
	});
	const client = new Client({ name: "bench", version: "0" }, { capabilities: {} });
	await client.connect(transport);

	const call = (name, args) => client.callTool({ name, arguments: args });

	const bodyBase = "# Doc\n\n" + "lorem ipsum dolor sit amet. ".repeat(40);

	// Warm + measure read_file
	const readS = [], writeS = [], editS = [];
	for (let i = 0; i < WARMUP + ITERS; i++) {
		const t = await timeIt(async () => { await call("read_file", { path: "bench.md" }); });
		if (i >= WARMUP) readS.push(t);
	}
	// write_file (whole file) — read once to prime sha cache in shim
	await call("read_file", { path: "bench.md" });
	for (let i = 0; i < WARMUP + ITERS; i++) {
		const t = await timeIt(async () => {
			await call("write_file", { path: "bench.md", content: bodyBase + "\n\nw " + i, force: true });
		});
		if (i >= WARMUP) writeS.push(t);
	}
	// edit_file (read+replace+write inside one tool call)
	await call("write_file", { path: "bench.md", content: bodyBase + "\n\nseed", force: true });
	for (let i = 0; i < WARMUP + ITERS; i++) {
		const find = i === 0 ? "seed" : "e " + (i - 1);
		const t = await timeIt(async () => {
			await call("edit_file", { path: "bench.md", find, replace: "e " + i });
		});
		if (i >= WARMUP) editS.push(t);
	}

	const results = [stats("read_file", readS), stats("write_file (whole-file)", writeS), stats("edit_file (read+write)", editS)];
	console.log(`\nE2E MCP benchmark — full stack minus LLM  (iters=${ITERS}, warmup=${WARMUP})`);
	console.log(`target: ${baseUrl}${serverProc ? " (local standalone)" : " (remote)"}\n`);
	console.log(["tool".padEnd(26), "p50", "p95", "p99", "mean", "max"].join("  "));
	for (const r of results) {
		console.log([
			r.label.padEnd(26),
			`${r.p50.toFixed(1)}ms`.padStart(8),
			`${r.p95.toFixed(1)}ms`.padStart(8),
			`${r.p99.toFixed(1)}ms`.padStart(8),
			`${r.mean.toFixed(1)}ms`.padStart(8),
			`${r.max.toFixed(1)}ms`.padStart(8),
		].join("  "));
	}
	console.log("");

	await client.close();
	if (serverProc) serverProc.kill("SIGTERM");
	if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
	if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
	process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
