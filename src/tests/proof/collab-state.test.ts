/**
 * Phase 3 tests — collab-state computation, lease store, X-Collab-* headers,
 * and R6 TOCTOU enforcement on raw .md PUT.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp, rm, writeFile, mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { setRootDir } from "../../lib/root-dir.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { writeSidecar, emptySidecar } from "../../lib/proof/sidecar.js";
import { setLease, clearLease, leaseGeneration, hasActiveLease, _resetLeaseStore, LEASE_TTL_MS } from "../../lib/proof/lease.js";
import { computeCollabState } from "../../lib/proof/collab-state.js";
import { _resetAuditDb } from "../../lib/proof/audit.js";
import type { Sidecar, Suggestion, Comment } from "../../lib/proof/types.js";

// ── Route handlers ────────────────────────────────────────────────────────────
let fileGET: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let filePUT: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;
let tier2GET: (req: Request, ctx: { params: Promise<{ path: string[] }> }) => Promise<Response>;

let tmpHome: string;
let tmpRoot: string;
let MUTATE_TOKEN: string;
let READ_TOKEN: string;

function sha256hex(buf: Buffer | string): string {
	const b = typeof buf === "string" ? Buffer.from(buf) : buf;
	return "sha256:" + createHash("sha256").update(b).digest("hex");
}

function agentHeaders(token: string, id: string, extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${token}`, "X-Agent-Id": id, ...extra };
}

function makeCtx(segments: string[]): { params: Promise<{ path: string[] }> } {
	return { params: Promise.resolve({ path: segments }) };
}

function fileUrl(rel: string, qs = ""): string {
	return `http://localhost/api/agent/fs/file/${rel}${qs}`;
}

function tier2Url(rel: string): string {
	return `http://localhost/api/agent/files/${rel}`;
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "collab-state-home-"));
	tmpRoot = await mkdtemp(path.join(tmpdir(), "collab-state-root-"));

	process.env.HOME = tmpHome;
	setRootDir(tmpRoot);
	_resetAuditDb();
	_resetLeaseStore();

	await ensureRegistry();

	MUTATE_TOKEN = randomBytes(32).toString("hex");
	READ_TOKEN = randomBytes(32).toString("hex");

	await addAgent({
		id: "ai:mutate",
		displayName: "Mutate",
		tokenHash: hashToken(MUTATE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate", "delete"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:reader",
		displayName: "Reader",
		tokenHash: hashToken(READ_TOKEN),
		scope: { paths: ["**/*"], ops: ["read"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	const fileRoute = await import("../../app/api/agent/fs/file/[...path]/route.js");
	fileGET = fileRoute.GET;
	filePUT = fileRoute.PUT;

	const tier2Route = await import("../../app/api/agent/files/[...path]/route.js");
	tier2GET = tier2Route.GET;
});

after(async () => {
	_resetLeaseStore();
	await rm(tmpHome, { recursive: true, force: true });
	await rm(tmpRoot, { recursive: true, force: true });
});

// ── Lease store unit tests ────────────────────────────────────────────────────

const TEST_NS = "/test-ns";

describe("lease store", () => {
	before(() => _resetLeaseStore());
	after(() => _resetLeaseStore());

	test("new path has generation 0, no active lease", () => {
		_resetLeaseStore();
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), 0);
		assert.equal(hasActiveLease(TEST_NS, "docs/a.md"), false);
	});

	test("setLease makes lease active, bumps generation 0→1", () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/a.md", "u1");
		assert.equal(hasActiveLease(TEST_NS, "docs/a.md"), true);
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), 1);
	});

	test("second setLease (heartbeat) does NOT bump generation again", () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/a.md", "u1");
		const gen = leaseGeneration(TEST_NS, "docs/a.md");
		setLease(TEST_NS, "docs/a.md", "u1"); // heartbeat
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), gen); // unchanged
	});

	test("clearLease removes active lease and bumps generation 1→2", () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/a.md", "u1");
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), 1);
		clearLease(TEST_NS, "docs/a.md", "u1");
		assert.equal(hasActiveLease(TEST_NS, "docs/a.md"), false);
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), 2);
	});

	test("clearLease by different user is no-op", () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/a.md", "u1");
		clearLease(TEST_NS, "docs/a.md", "u-other");
		assert.equal(hasActiveLease(TEST_NS, "docs/a.md"), true);
		assert.equal(leaseGeneration(TEST_NS, "docs/a.md"), 1);
	});

	test("expired lease (via short TTL) returns false and bumps generation", async () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/expire.md", "u1", 10); // 10ms TTL
		assert.equal(hasActiveLease(TEST_NS, "docs/expire.md"), true);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(hasActiveLease(TEST_NS, "docs/expire.md"), false);
		// generation bumped on expiry check
		assert.ok(leaseGeneration(TEST_NS, "docs/expire.md") >= 2);
	});

	test("set after expiry = new 0→1 transition, bumps again", async () => {
		_resetLeaseStore();
		setLease(TEST_NS, "docs/exp2.md", "u1", 10);
		await new Promise((r) => setTimeout(r, 20));
		hasActiveLease(TEST_NS, "docs/exp2.md"); // triggers sweep
		const genAfterExpiry = leaseGeneration(TEST_NS, "docs/exp2.md");
		setLease(TEST_NS, "docs/exp2.md", "u1"); // fresh open
		assert.equal(leaseGeneration(TEST_NS, "docs/exp2.md"), genAfterExpiry + 1);
	});
});

// ── computeCollabState matrix ─────────────────────────────────────────────────

describe("computeCollabState", () => {
	before(() => _resetLeaseStore());
	after(() => _resetLeaseStore());

	test("not-markdown: txt file", async () => {
		const result = await computeCollabState(tmpRoot, "file.txt");
		assert.equal(result.state, "not-markdown");
		assert.equal(result.revision, 0);
		assert.equal(result.snapshotUrl, null);
	});

	test("not-markdown: ts file", async () => {
		const result = await computeCollabState(tmpRoot, "src/app.ts");
		assert.equal(result.state, "not-markdown");
	});

	test("untracked: .md, no sidecar, no lease", async () => {
		_resetLeaseStore();
		await writeFile(path.join(tmpRoot, "untracked.md"), "# hello");
		const result = await computeCollabState(tmpRoot, "untracked.md");
		assert.equal(result.state, "untracked");
		assert.equal(result.snapshotUrl, "/api/agent/files/untracked.md");
	});

	test("tracked: .md with sidecar, no artifacts, no lease", async () => {
		_resetLeaseStore();
		const mdPath = "tracked.md";
		await writeFile(path.join(tmpRoot, mdPath), "# tracked");
		const sc: Sidecar = {
			...emptySidecar(mdPath),
			revision: 3,
			suggestions: [],
			comments: [],
			blockProvenance: {},
		};
		await writeSidecar(tmpRoot, mdPath, sc);
		const result = await computeCollabState(tmpRoot, mdPath);
		assert.equal(result.state, "tracked");
		assert.equal(result.revision, 3); // sidecar.revision + leaseGen(0)
	});

	test("active: .md with pending suggestion", async () => {
		_resetLeaseStore();
		const mdPath = "active-suggestion.md";
		await writeFile(path.join(tmpRoot, mdPath), "# active");
		const sc: Sidecar = {
			...emptySidecar(mdPath),
			revision: 5,
			suggestions: [
				{
					id: "s0001", ref: "b000001", kind: "replace", status: "pending",
					by: "ai:test", createdAt: new Date().toISOString(),
				} as Suggestion,
			],
			comments: [],
			blockProvenance: {},
		};
		await writeSidecar(tmpRoot, mdPath, sc);
		const result = await computeCollabState(tmpRoot, mdPath);
		assert.equal(result.state, "active");
		assert.equal(result.revision, 5);
	});

	test("active: .md with unresolved comment", async () => {
		_resetLeaseStore();
		const mdPath = "active-comment.md";
		await writeFile(path.join(tmpRoot, mdPath), "# active");
		const sc: Sidecar = {
			...emptySidecar(mdPath),
			revision: 2,
			suggestions: [],
			comments: [
				{
					id: "c0001", ref: "b000002", resolved: false,
					createdAt: new Date().toISOString(), turns: [],
				} as Comment,
			],
			blockProvenance: {},
		};
		await writeSidecar(tmpRoot, mdPath, sc);
		const result = await computeCollabState(tmpRoot, mdPath);
		assert.equal(result.state, "active");
	});

	test("active: .md via lease only (no sidecar)", async () => {
		_resetLeaseStore();
		const mdPath = "lease-only.md";
		await writeFile(path.join(tmpRoot, mdPath), "# lease only");
		// No sidecar; human opens it
		setLease(tmpRoot, mdPath, "human-user-1");
		const result = await computeCollabState(tmpRoot, mdPath);
		assert.equal(result.state, "active");
		assert.equal(result.revision, 1); // 0 + gen(1)
		clearLease(tmpRoot, mdPath, "human-user-1");
	});

	test("revision = sidecar.revision + leaseGeneration", async () => {
		_resetLeaseStore();
		const mdPath = "revision-test.md";
		await writeFile(path.join(tmpRoot, mdPath), "# rev");
		const sc: Sidecar = { ...emptySidecar(mdPath), revision: 7 };
		await writeSidecar(tmpRoot, mdPath, sc);
		// no lease: gen=0, revision=7
		const r1 = await computeCollabState(tmpRoot, mdPath);
		assert.equal(r1.revision, 7);
		// open lease: gen=1, revision=8
		setLease(tmpRoot, mdPath, "u1");
		const r2 = await computeCollabState(tmpRoot, mdPath);
		assert.equal(r2.revision, 8);
		clearLease(tmpRoot, mdPath, "u1");
	});

	test("stale pending suggestion does NOT count as active artifact", async () => {
		_resetLeaseStore();
		const mdPath = "stale-sug.md";
		await writeFile(path.join(tmpRoot, mdPath), "# stale");
		const sc: Sidecar = {
			...emptySidecar(mdPath),
			revision: 1,
			suggestions: [
				{
					id: "s0002", ref: "b000003", kind: "replace", status: "pending",
					by: "ai:test", createdAt: new Date().toISOString(),
					stale: true,
				} as Suggestion,
			],
			comments: [],
			blockProvenance: {},
		};
		await writeSidecar(tmpRoot, mdPath, sc);
		const result = await computeCollabState(tmpRoot, mdPath);
		assert.equal(result.state, "tracked"); // stale suggestion = no artifact
	});
});

// ── X-Collab-* headers on GET (fs/file) ──────────────────────────────────────

describe("X-Collab headers on GET fs/file", () => {
	before(() => _resetLeaseStore());
	after(() => _resetLeaseStore());

	test("non-markdown returns X-Collab-State: not-markdown, no snapshot header", async () => {
		await writeFile(path.join(tmpRoot, "code.ts"), "export const x = 1;");
		const req = new Request(fileUrl("code.ts"), {
			headers: agentHeaders(READ_TOKEN, "ai:reader"),
		});
		const res = await fileGET(req, makeCtx(["code.ts"]));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-collab-state"), "not-markdown");
		assert.equal(res.headers.get("x-collab-snapshot"), null);
	});

	test("untracked .md returns X-Collab-State: untracked + snapshot URL", async () => {
		_resetLeaseStore();
		await writeFile(path.join(tmpRoot, "hdr-untracked.md"), "# hello");
		const req = new Request(fileUrl("hdr-untracked.md"), {
			headers: agentHeaders(READ_TOKEN, "ai:reader"),
		});
		const res = await fileGET(req, makeCtx(["hdr-untracked.md"]));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-collab-state"), "untracked");
		assert.ok(res.headers.get("x-collab-snapshot")?.includes("hdr-untracked.md"));
		assert.ok(res.headers.get("x-collab-revision") !== null);
	});

	test("active lease makes X-Collab-State: active on GET", async () => {
		_resetLeaseStore();
		const mdPath = "hdr-active.md";
		await writeFile(path.join(tmpRoot, mdPath), "# active");
		setLease(tmpRoot, mdPath, "human-1");
		const req = new Request(fileUrl(mdPath), {
			headers: agentHeaders(READ_TOKEN, "ai:reader"),
		});
		const res = await fileGET(req, makeCtx([mdPath]));
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("x-collab-state"), "active");
		clearLease(tmpRoot, mdPath, "human-1");
	});
});

// ── X-Collab-* headers on GET agent/files (Tier-2) ────────────────────────────

describe("X-Collab headers on Tier-2 GET agent/files", () => {
	before(() => _resetLeaseStore());
	after(() => _resetLeaseStore());

	test("Tier-2 GET returns X-Collab-State + revision headers", async () => {
		_resetLeaseStore();
		const mdPath = "tier2-hdr.md";
		await writeFile(path.join(tmpRoot, mdPath), "# tier2");
		const req = new Request(tier2Url(mdPath), {
			headers: agentHeaders(READ_TOKEN, "ai:reader"),
		});
		const res = await tier2GET(req, makeCtx([mdPath]));
		assert.equal(res.status, 200);
		assert.ok(res.headers.get("x-collab-state") !== null, "X-Collab-State present");
		assert.ok(res.headers.get("x-collab-revision") !== null, "X-Collab-Revision present");
		assert.ok(res.headers.get("x-collab-snapshot") !== null, "X-Collab-Snapshot present");
	});

	test("Tier-2 GET returns active when lease set", async () => {
		_resetLeaseStore();
		const mdPath = "tier2-active.md";
		await writeFile(path.join(tmpRoot, mdPath), "# active");
		setLease(tmpRoot, mdPath, "h1");
		const req = new Request(tier2Url(mdPath), {
			headers: agentHeaders(READ_TOKEN, "ai:reader"),
		});
		const res = await tier2GET(req, makeCtx([mdPath]));
		assert.equal(res.headers.get("x-collab-state"), "active");
		clearLease(tmpRoot, mdPath, "h1");
	});
});

// ── R6 TOCTOU enforcement ─────────────────────────────────────────────────────

describe("R6 TOCTOU enforcement on raw .md PUT", () => {
	before(() => _resetLeaseStore());
	after(() => _resetLeaseStore());

	test("PUT .md with no lease (untracked) → 200 no If-Collab-Match needed", async () => {
		_resetLeaseStore();
		const mdPath = "r6-untracked.md";
		await writeFile(path.join(tmpRoot, mdPath), "# hello");
		const content = Buffer.from("# hello updated");
		const oldSha = sha256hex(Buffer.from("# hello"));
		const req = new Request(fileUrl(mdPath), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate", {
				"If-Match": oldSha,
				"Content-Type": "text/markdown",
			}),
			body: content,
		});
		const res = await filePUT(req, makeCtx([mdPath]));
		assert.equal(res.status, 200, "untracked md PUT should succeed");
	});

	test("PUT .md: doc goes active (lease set) between read and write → 409 COLLAB_ACTIVE", async () => {
		_resetLeaseStore();
		const mdPath = "r6-race.md";
		const initial = "# race test";
		await writeFile(path.join(tmpRoot, mdPath), initial);
		const oldSha = sha256hex(Buffer.from(initial));

		// Simulate: agent read the file, then human opens it (lease set)
		setLease(tmpRoot, mdPath, "human-racer");

		// Agent tries raw PUT without If-Collab-Match
		const req = new Request(fileUrl(mdPath), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate", {
				"If-Match": oldSha,
				"Content-Type": "text/markdown",
			}),
			body: Buffer.from("# overwritten"),
		});
		const res = await filePUT(req, makeCtx([mdPath]));
		assert.equal(res.status, 409, "should 409 when doc went active mid-flight");
		const body = await res.json() as { error: string; snapshotUrl: string; revision: number };
		assert.equal(body.error, "COLLAB_ACTIVE");
		assert.ok(body.snapshotUrl, "snapshotUrl in response");
		assert.ok(typeof body.revision === "number", "revision in response");

		clearLease(tmpRoot, mdPath, "human-racer");
	});

	test("PUT .md with matching If-Collab-Match → 200", async () => {
		_resetLeaseStore();
		const mdPath = "r6-match.md";
		const initial = "# match test";
		await writeFile(path.join(tmpRoot, mdPath), initial);
		const oldSha = sha256hex(Buffer.from(initial));

		setLease(tmpRoot, mdPath, "human-match");
		// Get the current revision
		const { revision } = await computeCollabState(tmpRoot, mdPath);

		const req = new Request(fileUrl(mdPath), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate", {
				"If-Match": oldSha,
				"If-Collab-Match": String(revision),
				"Content-Type": "text/markdown",
			}),
			body: Buffer.from("# matched and written"),
		});
		const res = await filePUT(req, makeCtx([mdPath]));
		assert.equal(res.status, 200, "matching If-Collab-Match should allow write");

		clearLease(tmpRoot, mdPath, "human-match");
	});

	test("PUT .md with ?force=true bypasses R6 even on active doc → 200", async () => {
		_resetLeaseStore();
		const mdPath = "r6-force.md";
		const initial = "# force test";
		await writeFile(path.join(tmpRoot, mdPath), initial);
		const oldSha = sha256hex(Buffer.from(initial));

		setLease(tmpRoot, mdPath, "human-force");

		const req = new Request(fileUrl(mdPath, "?force=true"), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate", {
				"If-Match": oldSha,
				"Content-Type": "text/markdown",
			}),
			body: Buffer.from("# forced overwrite"),
		});
		const res = await filePUT(req, makeCtx([mdPath]));
		assert.equal(res.status, 200, "?force=true should bypass R6");

		clearLease(tmpRoot, mdPath, "human-force");
	});

	test("PUT non-.md file is never blocked by R6 (no collab state)", async () => {
		_resetLeaseStore();
		const tsPath = "r6-noblock.ts";
		await writeFile(path.join(tmpRoot, tsPath), "const x = 1;");
		const oldSha = sha256hex(Buffer.from("const x = 1;"));

		const req = new Request(fileUrl(tsPath), {
			method: "PUT",
			headers: agentHeaders(MUTATE_TOKEN, "ai:mutate", {
				"If-Match": oldSha,
				"Content-Type": "text/plain",
			}),
			body: Buffer.from("const x = 2;"),
		});
		const res = await filePUT(req, makeCtx([tsPath]));
		assert.equal(res.status, 200, "non-md should never hit R6");
	});
});
