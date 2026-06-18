import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setRootDir } from "../../lib/root-dir.js";

// Import route handlers (disk reads are lazy — happen at request time)
import { GET as filesGET, POST as filesPOST } from "../../app/api/agent/files/[...path]/route.js";
import { _resetBuckets } from "../../lib/proof/rate-limit.js";
import { GET as eventsGET, POST as ackPOST } from "../../app/api/agent/events/[...path]/route.js";
import { GET as sidecarGET } from "../../app/api/agent/sidecar/[...path]/route.js";
import { GET as settingsGET } from "../../app/api/agent/settings/route.js";
import { POST as regeneratePOST } from "../../app/api/agent/settings/token/regenerate/route.js";
import { GET as activityGET } from "../../app/api/agent/activity/route.js";
import { POST as revokePOST } from "../../app/api/agent/admin/agents/[agentId]/revoke/route.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { makeUserSession } from "./helpers/auth-session.js";

let tmpHome: string;
let tmpRoot: string;
let TEST_TOKEN: string;
let RATE_TOKEN: string;
let RESTRICTED_TOKEN: string;
let REVOKE_TOKEN: string;

before(async () => {
	// Isolated HOME so registry writes go to tmpHome/.wiki-viewer
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-home-test-"));
	process.env.HOME = tmpHome;

	// Wiki files root
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-routes-test-"));
	setRootDir(tmpRoot);

	// Create registry and add test agents
	await ensureRegistry();

	TEST_TOKEN = randomBytes(32).toString("hex");
	RATE_TOKEN = randomBytes(32).toString("hex");

	await addAgent({
		id: "ai:test",
		displayName: "Test Agent",
		tokenHash: hashToken(TEST_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:rate-limited-agent",
		displayName: "Rate Agent",
		tokenHash: hashToken(RATE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	RESTRICTED_TOKEN = randomBytes(32).toString("hex");
	REVOKE_TOKEN = randomBytes(32).toString("hex");

	await addAgent({
		id: "ai:restricted-agent",
		displayName: "Restricted Agent",
		tokenHash: hashToken(RESTRICTED_TOKEN),
		scope: { paths: ["work/*.md"], ops: ["read"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	await addAgent({
		id: "ai:revoke-agent",
		displayName: "Revoke Agent",
		tokenHash: hashToken(REVOKE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	// Create sidecar files for activity scope filter test
	const makeSidecar = (filePath: string) => ({
		schemaVersion: 1,
		path: filePath,
		revision: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		refMap: {},
		refAliases: {},
		comments: [],
		suggestions: [],
		archivedSuggestions: [],
		events: [
			{
				id: 1,
				type: "block.replace",
				at: new Date().toISOString(),
				by: "ai:test",
				ref: "b001",
			},
		],
		nextEventId: 2,
		lastAck: {},
		fingerprint: "",
		blockProvenance: {},
	});

	const proofDir = path.join(tmpRoot, ".proof");
	await mkdir(path.join(proofDir, "work"), { recursive: true });
	await mkdir(path.join(proofDir, "personal"), { recursive: true });
	await writeFile(
		path.join(proofDir, "work", "a.md.json"),
		JSON.stringify(makeSidecar("work/a.md")),
		"utf-8",
	);
	await writeFile(
		path.join(proofDir, "personal", "b.md.json"),
		JSON.stringify(makeSidecar("personal/b.md")),
		"utf-8",
	);
});

after(async () => {
	// Wait for any in-flight async updateLastSeen writes to finish
	await new Promise((r) => setTimeout(r, 50));
	await rm(tmpRoot, { recursive: true, force: true });
	await rm(tmpHome, { recursive: true, force: true });
});

function makeParams(segments: string[]): { params: Promise<{ path: string[] }> } {
	return { params: Promise.resolve({ path: segments }) };
}

function authHeaders(): Headers {
	const h = new Headers();
	h.set("Authorization", `Bearer ${TEST_TOKEN}`);
	h.set("X-Agent-Id", "ai:test");
	return h;
}

function makeGetReq(url: string, withAuth = true): Request {
	const h = withAuth ? authHeaders() : new Headers();
	return new Request(url, { method: "GET", headers: h });
}

function makePostReq(url: string, body: unknown, extra?: Record<string, string>, withAuth = true): Request {
	const h = withAuth ? authHeaders() : new Headers();
	h.set("Content-Type", "application/json");
	if (extra) {
		for (const [k, v] of Object.entries(extra)) h.set(k, v);
	}
	return new Request(url, { method: "POST", headers: h, body: JSON.stringify(body) });
}

	function hashText(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

// ── GET /api/agent/files/[...path] ──────────────────────────────────────────

test("GET snapshot - missing file returns 404", async () => {
	const req = makeGetReq("http://localhost:3000/api/agent/files/ghost.md");
	const res = await filesGET(req, makeParams(["ghost.md"]));
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "NOT_FOUND");
});

test("GET snapshot - existing file returns snapshot shape", async () => {
	await writeFile(path.join(tmpRoot, "hello.md"), "# Hello\n\nWorld.\n", "utf-8");
	const req = makeGetReq("http://localhost:3000/api/agent/files/hello.md");
	const res = await filesGET(req, makeParams(["hello.md"]));
	assert.equal(res.status, 200);
	const snap = (await res.json()) as { path: string; revision: number; blocks: unknown[] };
	assert.equal(snap.path, "hello.md");
	assert.equal(typeof snap.revision, "number");
	assert.ok(Array.isArray(snap.blocks));
	assert.equal(snap.blocks.length, 2);
});

test("GET snapshot - bad token returns 401", async () => {
	const req = makeGetReq("http://localhost:3000/api/agent/files/hello.md", false);
	const res = await filesGET(req, makeParams(["hello.md"]));
	assert.equal(res.status, 401);
});

test("GET snapshot - missing X-Agent-Id returns 401", async () => {
	const h = new Headers();
	h.set("Authorization", `Bearer ${TEST_TOKEN}`);
	const req = new Request("http://localhost:3000/api/agent/files/hello.md", { method: "GET", headers: h });
	const res = await filesGET(req, makeParams(["hello.md"]));
	assert.equal(res.status, 401);
});

test("GET snapshot - X-Agent-Id mismatch returns 401", async () => {
	const h = new Headers();
	h.set("Authorization", `Bearer ${TEST_TOKEN}`);
	h.set("X-Agent-Id", "ai:imposter");
	const req = new Request("http://localhost:3000/api/agent/files/hello.md", { method: "GET", headers: h });
	const res = await filesGET(req, makeParams(["hello.md"]));
	assert.equal(res.status, 401);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "UNAUTHORIZED");
});

test("GET snapshot - non-markdown path returns snapshot", async () => {
	await writeFile(path.join(tmpRoot, "notes.txt"), "Alpha\nBeta\n", "utf-8");
	const req = makeGetReq("http://localhost:3000/api/agent/files/notes.txt");
	const res = await filesGET(req, makeParams(["notes.txt"]));
	assert.equal(res.status, 200);
	const snap = (await res.json()) as { path: string; revision: number; blocks: unknown[] };
	assert.equal(snap.path, "notes.txt");
	assert.equal(typeof snap.revision, "number");
	assert.ok(Array.isArray(snap.blocks));
});

test("GET snapshot - .proof prefix returns 400", async () => {
	const req = makeGetReq("http://localhost:3000/api/agent/files/.proof/foo.md");
	const res = await filesGET(req, makeParams([".proof", "foo.md"]));
	assert.equal(res.status, 400);
});


test("GET/POST/sidecar - normalized .proof traversal returns 400", async () => {
	const segs = ["foo", "..", ".proof", "traverse.txt"];
	const getRes = await filesGET(
		makeGetReq("http://localhost:3000/api/agent/files/foo/../.proof/traverse.txt"),
		makeParams(segs),
	);
	assert.equal(getRes.status, 400);

	const postRes = await filesPOST(
		makePostReq(
			"http://localhost:3000/api/agent/files/foo/../.proof/traverse.txt",
			{ baseRevision: 0, by: "ai:test", ops: [] },
			{ "Idempotency-Key": "key-traverse-" + Date.now() },
		),
		makeParams(segs),
	);
	assert.equal(postRes.status, 400);

	const sidecarRes = await sidecarGET(
		makeGetReq("http://localhost:3000/api/agent/sidecar/foo/../.proof/traverse.txt"),
		makeParams(segs),
	);
	assert.equal(sidecarRes.status, 400);
});

// ── POST /api/agent/files/[...path] ────────────────────────────────────────

test("POST - missing Idempotency-Key returns 400", async () => {
	const req = makePostReq(
		"http://localhost:3000/api/agent/files/hello.md",
		{ baseRevision: 0, by: "ai:test", ops: [] },
	);
	const res = await filesPOST(req, makeParams(["hello.md"]));
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "MISSING_IDEMPOTENCY_KEY");
});

test("POST - bad token returns 401", async () => {
	const req = makePostReq(
		"http://localhost:3000/api/agent/files/hello.md",
		{ baseRevision: 0, by: "ai:test", ops: [] },
		{ "Idempotency-Key": "key-401" },
		false,
	);
	const res = await filesPOST(req, makeParams(["hello.md"]));
	assert.equal(res.status, 401);
});

test("POST - happy path append returns 200 with snapshot", async () => {
	await writeFile(path.join(tmpRoot, "post-happy.md"), "# Test\n\nOriginal.\n", "utf-8");

	const getReq = makeGetReq("http://localhost:3000/api/agent/files/post-happy.md");
	const getRes = await filesGET(getReq, makeParams(["post-happy.md"]));
	const snap = (await getRes.json()) as { revision: number };

	const req = makePostReq(
		"http://localhost:3000/api/agent/files/post-happy.md",
		{ baseRevision: snap.revision, by: "ai:test", ops: [{ type: "block.append", markdown: "New paragraph." }] },
		{ "Idempotency-Key": "key-happy-" + Date.now() },
	);
	const res = await filesPOST(req, makeParams(["post-happy.md"]));
	assert.equal(res.status, 200);
	const result = (await res.json()) as { revision: number; blocks: unknown[] };
	assert.ok(result);
	assert.equal(result.revision, snap.revision + 1);
	assert.ok(Array.isArray(result.blocks));
});

test("POST - stale revision returns 409 with snapshot", async () => {
	await writeFile(path.join(tmpRoot, "stale.md"), "# Stale\n\nContent.\n", "utf-8");
	const req = makePostReq(
		"http://localhost:3000/api/agent/files/stale.md",
		{ baseRevision: 9999, by: "ai:test", ops: [] },
		{ "Idempotency-Key": "key-stale-" + Date.now() },
	);
	const res = await filesPOST(req, makeParams(["stale.md"]));
	assert.equal(res.status, 409);
	const body = (await res.json()) as { error: string; snapshot: unknown };
	assert.equal(body.error, "STALE_REVISION");
	assert.ok(body.snapshot, "Should include snapshot on 409");
});

test("POST - idempotent replay returns same response", async () => {
	await writeFile(path.join(tmpRoot, "idem.md"), "# Idem\n\nText.\n", "utf-8");
	const getRes = await filesGET(
		makeGetReq("http://localhost:3000/api/agent/files/idem.md"),
		makeParams(["idem.md"]),
	);
	const snap = (await getRes.json()) as { revision: number };
	const key = "idem-key-" + Date.now();
	const payload = { baseRevision: snap.revision, by: "ai:test", ops: [{ type: "block.append", markdown: "Appended." }] };

	const r1 = await filesPOST(
		makePostReq("http://localhost:3000/api/agent/files/idem.md", payload, { "Idempotency-Key": key }),
		makeParams(["idem.md"]),
	);
	const r2 = await filesPOST(
		makePostReq("http://localhost:3000/api/agent/files/idem.md", payload, { "Idempotency-Key": key }),
		makeParams(["idem.md"]),
	);
	assert.equal(r1.status, r2.status);
	const b1 = await r1.text();
	const b2 = await r2.text();
	assert.equal(b1, b2, "Idempotent replay must return identical body");
});


test("POST text comment ops - comment.add/reply/resolve work on text files", async () => {
	await writeFile(path.join(tmpRoot, "notes.txt"), "Line one\nLine two\n", "utf-8");
	const lineHash = hashText("Line two");
	const addReq = makePostReq(
		"http://localhost:3000/api/agent/files/notes.txt",
		{
			baseRevision: 0,
			by: "ai:test",
			ops: [{ type: "comment.add", lineAnchor: { lineStart: 2, lineEnd: 2, textHash: lineHash }, text: "Note" }],
		},
		{ "Idempotency-Key": "key-text-add-" + Date.now() },
	);
	const addRes = await filesPOST(addReq, makeParams(["notes.txt"]));
	assert.equal(addRes.status, 200);
	const addBody = (await addRes.json()) as { revision: number; comments: Array<{ id: string; lineAnchor?: { lineStart: number; lineEnd: number; textHash: string } }> };
	assert.equal(addBody.comments.length, 1);
	assert.equal(addBody.comments[0].lineAnchor?.lineStart, 2);
	assert.equal(await readFile(path.join(tmpRoot, "notes.txt"), "utf-8"), "Line one\nLine two\n");

	const replyReq = makePostReq(
		"http://localhost:3000/api/agent/files/notes.txt",
		{ baseRevision: addBody.revision, by: "ai:test", ops: [{ type: "comment.reply", commentId: addBody.comments[0].id, text: "Reply" }] },
		{ "Idempotency-Key": "key-text-reply-" + Date.now() },
	);
	const replyRes = await filesPOST(replyReq, makeParams(["notes.txt"]));
	assert.equal(replyRes.status, 200);
	const replyBody = (await replyRes.json()) as { revision: number; comments: Array<{ turns: Array<{ text: string }> }> };
	assert.equal(replyBody.comments[0].turns.length, 2);
	assert.equal(replyBody.comments[0].turns[1].text, "Reply");

	const resolveReq = makePostReq(
		"http://localhost:3000/api/agent/files/notes.txt",
		{ baseRevision: replyBody.revision, by: "ai:test", ops: [{ type: "comment.resolve", commentId: addBody.comments[0].id }] },
		{ "Idempotency-Key": "key-text-resolve-" + Date.now() },
	);
	const resolveRes = await filesPOST(resolveReq, makeParams(["notes.txt"]));
	assert.equal(resolveRes.status, 200);
	const resolveBody = (await resolveRes.json()) as { revision: number; comments: Array<{ resolved: boolean }> };
	assert.equal(resolveBody.comments[0].resolved, true);

	const reopenReq = makePostReq(
		"http://localhost:3000/api/agent/files/notes.txt",
		{ baseRevision: resolveBody.revision, by: "ai:test", ops: [{ type: "comment.reopen", commentId: addBody.comments[0].id }] },
		{ "Idempotency-Key": "key-text-reopen-" + Date.now() },
	);
	const reopenRes = await filesPOST(reopenReq, makeParams(["notes.txt"]));
	assert.equal(reopenRes.status, 200);
	const reopenBody = (await reopenRes.json()) as { comments: Array<{ resolved: boolean }> };
	assert.equal(reopenBody.comments[0].resolved, false);
	assert.equal(await readFile(path.join(tmpRoot, "notes.txt"), "utf-8"), "Line one\nLine two\n");
});


test("POST text comment ops - rejects mismatched or out-of-range lineAnchor", async () => {
	await writeFile(path.join(tmpRoot, "bad-anchor.txt"), "Line one\nLine two\n", "utf-8");

	const badHashReq = makePostReq(
		"http://localhost:3000/api/agent/files/bad-anchor.txt",
		{
			baseRevision: 0,
			by: "ai:test",
			ops: [{ type: "comment.add", lineAnchor: { lineStart: 2, lineEnd: 2, textHash: "deadbeef" }, text: "Note" }],
		},
		{ "Idempotency-Key": "key-bad-anchor-" + Date.now() },
	);
	const badHashRes = await filesPOST(badHashReq, makeParams(["bad-anchor.txt"]));
	assert.equal(badHashRes.status, 400);

	const oobReq = makePostReq(
		"http://localhost:3000/api/agent/files/bad-anchor.txt",
		{
			baseRevision: 0,
			by: "ai:test",
			ops: [{ type: "comment.add", lineAnchor: { lineStart: 3, lineEnd: 3, textHash: hashText("Line three") }, text: "Note" }],
		},
		{ "Idempotency-Key": "key-bad-anchor-oob-" + Date.now() },
	);
	const oobRes = await filesPOST(oobReq, makeParams(["bad-anchor.txt"]));
	assert.equal(oobRes.status, 400);
});

test("POST text comment ops - suggestions still rejected on text files", async () => {
	await writeFile(path.join(tmpRoot, "suggest.txt"), "Text only\n", "utf-8");
	const req = makePostReq(
		"http://localhost:3000/api/agent/files/suggest.txt",
		{ baseRevision: 0, by: "human", ops: [{ type: "suggestion.add", ref: "b000001", kind: "replace", markdown: "Nope" }] },
		{ "Idempotency-Key": "key-text-suggest-" + Date.now() },
	);
	const res = await filesPOST(req, makeParams(["suggest.txt"]));
	assert.equal(res.status, 400);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "INVALID_PATH");
});


test("GET sidecar - text anchors re-anchor on nearby edit and go stale otherwise", async () => {
	await mkdir(path.join(tmpRoot, ".proof"), { recursive: true });
	const now = new Date().toISOString();
	const sidecar = {
		schemaVersion: 1,
		path: "notes.txt",
		revision: 0,
		createdAt: now,
		updatedAt: now,
		refMap: {},
		refAliases: {},
		comments: [
			{
				id: "c0001",
				lineAnchor: { lineStart: 2, lineEnd: 2, textHash: hashText("beta") },
				resolved: false,
				createdAt: now,
				turns: [{ by: "human", text: "Note", at: now }],
			},
		],
		suggestions: [],
		archivedSuggestions: [],
		events: [],
		nextEventId: 1,
		lastAck: {},
		fingerprint: "",
		blockProvenance: {},
	};

	await writeFile(path.join(tmpRoot, "notes.txt"), "alpha\nbeta\ngamma\n", "utf-8");
	await writeFile(path.join(tmpRoot, ".proof", "notes.txt.json"), JSON.stringify(sidecar, null, 2), "utf-8");

	const first = await sidecarGET(makeGetReq("http://localhost:3000/api/agent/sidecar/notes.txt"), makeParams(["notes.txt"]));
	assert.equal(first.status, 200);
	const firstBody = (await first.json()) as { comments: Array<{ lineAnchor?: { lineStart: number; lineEnd: number }; stale?: boolean }> };
	assert.equal(firstBody.comments[0].lineAnchor?.lineStart, 2);
	assert.equal(firstBody.comments[0].stale ?? false, false);

	await writeFile(path.join(tmpRoot, "notes.txt"), "alpha\nx\nbeta\ngamma\n", "utf-8");
	const second = await sidecarGET(makeGetReq("http://localhost:3000/api/agent/sidecar/notes.txt"), makeParams(["notes.txt"]));
	assert.equal(second.status, 200);
	const secondBody = (await second.json()) as { comments: Array<{ lineAnchor?: { lineStart: number; lineEnd: number }; stale?: boolean }> };
	assert.equal(secondBody.comments[0].lineAnchor?.lineStart, 3);
	assert.equal(secondBody.comments[0].stale ?? false, false);

	await writeFile(path.join(tmpRoot, "notes.txt"), "alpha\nx\ny\ngamma\n", "utf-8");
	const third = await sidecarGET(makeGetReq("http://localhost:3000/api/agent/sidecar/notes.txt"), makeParams(["notes.txt"]));
	assert.equal(third.status, 200);
	const thirdBody = (await third.json()) as { comments: Array<{ stale?: boolean }> };
	assert.equal(thirdBody.comments[0].stale, true);
});

// ── GET /api/agent/events/[...path] ──────────────────────────────────────

test("GET events - returns events array and lastEventId for fresh file", async () => {
	await writeFile(path.join(tmpRoot, "events-test.md"), "# Events\n", "utf-8");
	const req = makeGetReq("http://localhost:3000/api/agent/events/events-test.md?after=0");
	const res = await eventsGET(req, makeParams(["events-test.md"]));
	assert.equal(res.status, 200);
	const body = (await res.json()) as { events: unknown[]; lastEventId: number };
	assert.ok(Array.isArray(body.events));
	assert.equal(typeof body.lastEventId, "number");
});

test("GET events - bad token returns 401", async () => {
	const req = makeGetReq("http://localhost:3000/api/agent/events/events-test.md", false);
	const res = await eventsGET(req, makeParams(["events-test.md"]));
	assert.equal(res.status, 401);
});

// ── POST /api/agent/events/[...path] ─────────────────────────────────────

test("POST ack - acknowledges event id", async () => {
	await writeFile(path.join(tmpRoot, "ack-test.md"), "# Ack\n", "utf-8");
	const req = makePostReq(
		"http://localhost:3000/api/agent/events/ack-test.md",
		{ upToId: 5, by: "ai:test" },
	);
	const res = await ackPOST(req, makeParams(["ack-test.md"]));
	assert.equal(res.status, 200);
	const body = (await res.json()) as { ok: boolean };
	assert.equal(body.ok, true);
});

test("POST ack - bad token returns 401", async () => {
	const req = makePostReq(
		"http://localhost:3000/api/agent/events/ack-test.md",
		{ upToId: 5, by: "ai:test" },
		{},
		false,
	);
	const res = await ackPOST(req, makeParams(["ack-test.md"]));
	assert.equal(res.status, 401);
});

// ── GET /api/agent/sidecar/[...path] ───────────────────────────────────────

test("GET sidecar - returns sidecar shape", async () => {
	await writeFile(path.join(tmpRoot, "sidecar-test.md"), "# Sidecar\n", "utf-8");
	const req = makeGetReq("http://localhost:3000/api/agent/sidecar/sidecar-test.md");
	const res = await sidecarGET(req, makeParams(["sidecar-test.md"]));
	assert.equal(res.status, 200);
	const sc = (await res.json()) as { schemaVersion: number; events: unknown[] };
	assert.equal(sc.schemaVersion, 1);
	assert.ok(Array.isArray(sc.events));
});

// ── GET /api/agent/settings ────────────────────────────────────────────────

test("GET settings - returns config", async () => {
	const req = makeGetReq("http://localhost:3000/api/agent/settings");
	const res = await settingsGET(req);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { rateLimit: number; root: string; registeredAgents: number };
	assert.equal(body.rateLimit, 60);
	assert.ok(typeof body.root === "string");
	assert.ok(typeof body.registeredAgents === "number");
	assert.ok(body.registeredAgents >= 1, "Should have at least one registered agent");
	const bodyStr = JSON.stringify(body);
	assert.ok(!bodyStr.includes(TEST_TOKEN), "Token value must not appear in response");
});

// ── POST rate-limit (429) ─────────────────────────────────────────────────

test("POST - rate-limited agent returns 429 with Retry-After", async () => {
	_resetBuckets();
	await writeFile(path.join(tmpRoot, "rate-test.md"), "# Rate\n\nContent.\n", "utf-8");

	// Get current revision using main test token
	const getRes = await filesGET(
		makeGetReq("http://localhost:3000/api/agent/files/rate-test.md"),
		makeParams(["rate-test.md"]),
	);
	const snap = (await getRes.json()) as { revision: number };

	// Use rate-limited-agent's own token + matching by field
	const rateHeaders = new Headers();
	rateHeaders.set("Authorization", `Bearer ${RATE_TOKEN}`);
	rateHeaders.set("X-Agent-Id", "ai:rate-limited-agent");
	rateHeaders.set("Content-Type", "application/json");
	rateHeaders.set("Idempotency-Key", "rate-limit-key-" + Date.now());

	const ops = Array.from({ length: 61 }, (_, i) => ({
		type: "block.append",
		markdown: `Paragraph ${i}.`,
	}));

	const req = new Request("http://localhost:3000/api/agent/files/rate-test.md", {
		method: "POST",
		headers: rateHeaders,
		body: JSON.stringify({ baseRevision: snap.revision, by: "ai:rate-limited-agent", ops }),
	});
	const res = await filesPOST(req, makeParams(["rate-test.md"]));
	assert.equal(res.status, 429);
	const body = (await res.json()) as { error: string; retryAfterMs: number };
	assert.equal(body.error, "RATE_LIMITED");
	assert.ok(body.retryAfterMs > 0, "retryAfterMs must be positive");
	assert.ok(res.headers.get("Retry-After") !== null, "Retry-After header must be set");
});

// ── POST /api/agent/settings/token/regenerate ──────────────────────────────

test("POST regenerate - returns 410 Gone", async () => {
	const req = new Request("http://localhost:3000/api/agent/settings/token/regenerate", { method: "POST" });
	const res = await regeneratePOST(req);
	assert.equal(res.status, 410);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "GONE");
});

// ── Oracle fix #2: activity scope filter ────────────────────────────────────

test("GET /api/agent/activity - restricted agent sees only scoped events", async () => {
	// tmpRoot has sidecar for work/a.md and personal/b.md (set up in before)
	const h = new Headers();
	h.set("Authorization", `Bearer ${RESTRICTED_TOKEN}`);
	h.set("X-Agent-Id", "ai:restricted-agent");
	const req = new Request("http://localhost:3000/api/agent/activity", { method: "GET", headers: h });
	const res = await activityGET(req);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { events: Array<{ path: string }> };
	// restricted agent scope is work/*.md — only work/a.md should appear
	const paths = body.events.map((e) => e.path);
	assert.ok(paths.every((p) => p.startsWith("work/")), "Only work/* paths visible");
	assert.ok(paths.includes("work/a.md"), "work/a.md present");
	assert.ok(!paths.includes("personal/b.md"), "personal/b.md excluded");
});

test("GET /api/agent/activity?file=personal/b.md - restricted agent gets 403", async () => {
	const h = new Headers();
	h.set("Authorization", `Bearer ${RESTRICTED_TOKEN}`);
	h.set("X-Agent-Id", "ai:restricted-agent");
	const req = new Request(
		"http://localhost:3000/api/agent/activity?file=personal/b.md",
		{ method: "GET", headers: h },
	);
	const res = await activityGET(req);
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "FORBIDDEN");
});

// ── Oracle item 12: additional coverage ───────────────────────────────────────

test("GET snapshot - scope path mismatch returns 403", async () => {
	// restricted agent (scope: work/*.md) tries to read personal/b.md
	await writeFile(path.join(tmpRoot, "personal-test.md"), "# Personal\n", "utf-8");
	const h = new Headers();
	h.set("Authorization", `Bearer ${RESTRICTED_TOKEN}`);
	h.set("X-Agent-Id", "ai:restricted-agent");
	h.set("Content-Type", "application/json");
	const req = new Request(
		"http://localhost:3000/api/agent/files/personal-test.md",
		{ method: "GET", headers: h },
	);
	const res = await filesGET(req, makeParams(["personal-test.md"]));
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "FORBIDDEN");
});

test("POST - 'by' mismatch returns 403", async () => {
	await writeFile(path.join(tmpRoot, "by-mismatch.md"), "# By\n\nContent.\n", "utf-8");
	const getRes = await filesGET(
		makeGetReq("http://localhost:3000/api/agent/files/by-mismatch.md"),
		makeParams(["by-mismatch.md"]),
	);
	const snap = (await getRes.json()) as { revision: number };

	const req = makePostReq(
		"http://localhost:3000/api/agent/files/by-mismatch.md",
		{ baseRevision: snap.revision, by: "ai:other", ops: [] },
		{ "Idempotency-Key": "by-mismatch-" + Date.now() },
	);
	const res = await filesPOST(req, makeParams(["by-mismatch.md"]));
	assert.equal(res.status, 403);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "FORBIDDEN");
});

test("Revoke followed by use returns 401", async () => {
	// Get Better Auth user session to authorize revoke
	const sessionCookie = await makeUserSession();

	// Revoke the agent
	const revokeReq = new Request(
		"http://localhost:3000/api/agent/admin/agents/ai:revoke-agent/revoke",
		{
			method: "POST",
			headers: { Cookie: sessionCookie },
		},
	);
	const revokeRes = await revokePOST(revokeReq, {
		params: Promise.resolve({ agentId: "ai:revoke-agent" }),
	});
	assert.equal(revokeRes.status, 200);

	// Now try to use the revoked token
	const h = new Headers();
	h.set("Authorization", `Bearer ${REVOKE_TOKEN}`);
	h.set("X-Agent-Id", "ai:revoke-agent");
	const useReq = new Request(
		"http://localhost:3000/api/agent/files/hello.md",
		{ method: "GET", headers: h },
	);
	const useRes = await filesGET(useReq, makeParams(["hello.md"]));
	assert.equal(useRes.status, 401);
	const body = (await useRes.json()) as { error: string };
	assert.equal(body.error, "UNAUTHORIZED");
});
