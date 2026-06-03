/**
 * Isolated write-path benchmark — NOT a test, NOT touching production state.
 *
 * Drives the real Tier-1 route handlers (filePUT / fileGET) against a throwaway
 * temp rootDir + temp HOME (lock dir), exactly like agent-fs.test.ts, and
 * measures end-to-end server-side latency for the write path:
 *   - non-.md overwrite (raw, no lock/sidecar)
 *   - .md overwrite (cross-proc lock + reconcile + sidecar write + datasync)
 *   - edit_file equivalent (GET + PUT round-trip on .md)
 *
 * Run:  npx tsx src/tests/proof/bench-write.ts
 * Optional env: BENCH_ITERS (default 300), BENCH_WARMUP (default 30)
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { setRootDir } from "../../lib/root-dir.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";

const ITERS = Number(process.env.BENCH_ITERS) || 300;
const WARMUP = Number(process.env.BENCH_WARMUP) || 30;

function sha256(buf: Buffer): string {
	return "sha256:" + createHash("sha256").update(buf).digest("hex");
}
function hdrs(token: string, id: string): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "X-Agent-Id": id };
}
function fileUrl(rel: string, qs = ""): string {
	return `http://localhost/api/agent/fs/file/${rel}${qs}`;
}

function pct(sorted: number[], p: number): number {
	const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[i];
}
function stats(label: string, samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	const sum = s.reduce((a, b) => a + b, 0);
	const mean = sum / s.length;
	return {
		label,
		n: s.length,
		mean: +mean.toFixed(3),
		p50: +pct(s, 50).toFixed(3),
		p95: +pct(s, 95).toFixed(3),
		p99: +pct(s, 99).toFixed(3),
		min: +s[0].toFixed(3),
		max: +s[s.length - 1].toFixed(3),
	};
}

async function timeIt(fn: () => Promise<void>): Promise<number> {
	const t0 = performance.now();
	await fn();
	return performance.now() - t0;
}

async function main() {
	const tmpHome = await mkdtemp(path.join(tmpdir(), "bench-home-"));
	const tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-root-"));
	process.env.HOME = tmpHome;
	setRootDir(tmpRoot);
	await ensureRegistry();

	const TOKEN = randomBytes(32).toString("hex");
	await addAgent({
		id: "ai:bench",
		displayName: "Bench",
		tokenHash: hashToken(TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate", "delete"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	const fileRoute = await import("../../app/api/agent/fs/file/[...path]/route.js");
	const filePUT = fileRoute.PUT;
	const fileGET = fileRoute.GET;
	const H = hdrs(TOKEN, "ai:bench");

	const ctx = (rel: string) => ({ params: Promise.resolve({ path: rel.split("/") }) });

	// Seed bodies (~1KB, realistic small doc)
	const body = Buffer.from("# Doc\n\n" + "lorem ipsum dolor sit amet. ".repeat(40));
	const txtBody = Buffer.from("config_value = " + "x".repeat(900));

	async function putOnce(rel: string, data: Buffer, ifMatch?: string, ifCollab?: string): Promise<Response> {
		const headers: Record<string, string> = { ...H, "Content-Type": "application/octet-stream" };
		if (ifMatch) headers["If-Match"] = ifMatch;
		if (ifCollab) headers["If-Collab-Match"] = ifCollab;
		return filePUT(new Request(fileUrl(rel), { method: "PUT", headers, body: new Uint8Array(data) }), ctx(rel));
	}
	async function getSha(rel: string): Promise<{ sha: string; collabRev: string | null }> {
		const res = await fileGET(new Request(fileUrl(rel), { headers: H }), ctx(rel));
		const etag = (res.headers.get("ETag") ?? "").replace(/"/g, "");
		return { sha: etag, collabRev: res.headers.get("X-Collab-Revision") };
	}

	// ── Scenario A: non-.md overwrite (lean path) ──────────────────────────────
	await putOnce("bench.txt", txtBody, undefined); // create
	const txtSamples: number[] = [];
	{
		let sha = (await getSha("bench.txt")).sha;
		for (let i = 0; i < WARMUP + ITERS; i++) {
			const data = Buffer.from(txtBody.toString() + i);
			const t = await timeIt(async () => {
				const res = await putOnce("bench.txt", data, sha);
				if (res.status !== 200) throw new Error("txt PUT " + res.status);
				sha = (await res.json() as { sha256: string }).sha256;
			});
			if (i >= WARMUP) txtSamples.push(t);
		}
	}

	// ── Scenario B: .md overwrite (lock + reconcile + sidecar + datasync) ──────
	await putOnce("bench.md", body, undefined); // create
	const mdSamples: number[] = [];
	{
		let sha = (await getSha("bench.md")).sha;
		for (let i = 0; i < WARMUP + ITERS; i++) {
			const data = Buffer.from(body.toString() + "\n\nedit " + i);
			const t = await timeIt(async () => {
				const res = await putOnce("bench.md", data, sha);
				if (res.status !== 200) throw new Error("md PUT " + res.status + " " + await res.text());
				sha = (await res.json() as { sha256: string }).sha256;
			});
			if (i >= WARMUP) mdSamples.push(t);
		}
	}

	// ── Scenario C: edit_file equivalent — GET + PUT round-trip on .md ─────────
	const editSamples: number[] = [];
	{
		for (let i = 0; i < WARMUP + ITERS; i++) {
			const data = Buffer.from(body.toString() + "\n\nrt " + i);
			const t = await timeIt(async () => {
				const { sha } = await getSha("bench.md");
				const res = await putOnce("bench.md", data, sha);
				if (res.status !== 200) throw new Error("edit PUT " + res.status);
				await res.json();
			});
			if (i >= WARMUP) editSamples.push(t);
		}
	}

	const results = [
		stats("non-.md overwrite (lean)", txtSamples),
		stats(".md overwrite (lock+reconcile+sidecar+datasync)", mdSamples),
		stats("edit_file (GET+PUT .md round-trip)", editSamples),
	];

	console.log(`\nwrite-path benchmark  (iters=${ITERS}, warmup=${WARMUP}, ~1KB bodies)\n`);
	console.log(
		["scenario".padEnd(48), "p50", "p95", "p99", "mean", "max"].join("  "),
	);
	for (const r of results) {
		console.log(
			[
				r.label.padEnd(48),
				`${r.p50}ms`.padStart(7),
				`${r.p95}ms`.padStart(7),
				`${r.p99}ms`.padStart(7),
				`${r.mean}ms`.padStart(7),
				`${r.max}ms`.padStart(7),
			].join("  "),
		);
	}
	console.log("");

	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
