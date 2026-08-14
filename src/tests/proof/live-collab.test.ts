/**
 * Live agent collaboration — control-plane loop.
 *
 * Covers: agent attach + presence, human dispatch reaching a held poll,
 * one-outstanding-per-session, stale/replay via deterministic idempotency key,
 * accept/discard notification, workspace isolation, presence timeout.
 *
 * The live channel never writes documents; edits land through the existing
 * tier-2 applyOps path. Tests assert the control-plane contract and that the
 * idempotency key / inResponseTo correlation is surfaced to the agent.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { createTestWorkspace, makeFile } from "./helpers/workspace.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";

let tmpHome: string;
let wsA: string;
let wsB: string;
let MUTATE_TOKEN: string;

// Route handlers (loaded after env is set).
let attachPOST: (req: Request) => Promise<Response>;
let pollGET: (req: Request) => Promise<Response>;
let replyPOST: (req: Request) => Promise<Response>;
let reqPOST: (req: Request) => Promise<Response>;
let statusGET: (req: Request) => Promise<Response>;
let store: typeof import("../../lib/proof/live/store.js");

function agentHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${MUTATE_TOKEN}`,
		"X-Agent-Id": "ai:live-agent",
		"Content-Type": "application/json",
	};
}

function agentUrl(route: string, ws: string, params: Record<string, string> = {}): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", ws);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

function userUrl(route: string, ws: string): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", ws);
	return url.toString();
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "live-home-"));
	process.env.HOME = tmpHome;
	process.env.WIKI_NO_AUTH = "1";

	const a = await createTestWorkspace({ name: "live-a" });
	const b = await createTestWorkspace({ name: "live-b" });
	wsA = a.workspace.id;
	wsB = b.workspace.id;
	await makeFile(a.rootDir, "doc.md", "# Title\n\nA paragraph.\n");

	await ensureRegistry();
	MUTATE_TOKEN = randomBytes(32).toString("hex");
	await addAgent({
		id: "ai:live-agent",
		displayName: "Live Agent",
		tokenHash: hashToken(MUTATE_TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	store = await import("../../lib/proof/live/store.js");
	store._resetForTests();

	attachPOST = (await import("../../app/api/agent/live/attach/route.js")).POST;
	pollGET = (await import("../../app/api/agent/live/poll/route.js")).GET;
	replyPOST = (await import("../../app/api/agent/live/reply/route.js")).POST;
	reqPOST = (await import("../../app/api/wiki/live/request/route.js")).POST;
	statusGET = (await import("../../app/api/wiki/live/status/route.js")).GET;
});

after(async () => {
	store?._resetForTests();
	await rm(tmpHome, { recursive: true, force: true });
	delete process.env.WIKI_NO_AUTH;
});

test("R1 — agent attaches and reports attached via status", async () => {
	const res = await attachPOST(
		new Request(agentUrl("/api/agent/live/attach", wsA), {
			method: "POST",
			headers: agentHeaders(),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { sessionId: string };
	assert.ok(body.sessionId);

	const st = await statusGET(
		new Request(userUrl("/api/wiki/live/status", wsA)),
	);
	const stBody = (await st.json()) as { attached: boolean };
	assert.equal(stBody.attached, true);
});

test("R2/R3 — human dispatch reaches held poll with idempotency + correlation", async () => {
	// Ensure a fresh attach for wsA.
	await attachPOST(
		new Request(agentUrl("/api/agent/live/attach", wsA), {
			method: "POST",
			headers: agentHeaders(),
		}),
	);

	// Start the long-poll, then dispatch shortly after so the held poll returns it.
	const pollPromise = pollGET(
		new Request(agentUrl("/api/agent/live/poll", wsA, { sessionId: currentSession(wsA), afterSeq: "0" }), {
			headers: agentHeaders(),
		}),
	);

	// Give the poll a moment to start holding.
	await new Promise((r) => setTimeout(r, 200));

	const dispatch = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: "doc.md",
				blockRef: "b123456",
				baseRevision: 0,
				kind: "generate",
				instruction: "make this concise",
			}),
		}),
	);
	assert.equal(dispatch.status, 200);
	const dBody = (await dispatch.json()) as { requestId: string };

	const pollRes = await pollPromise;
	const event = (await pollRes.json()) as {
		type: string;
		request: {
			requestId: string;
			idempotencyKey: string;
			inResponseTo: string;
			blockRef: string;
			baseRevision: number;
			instruction: string;
		};
	};
	assert.equal(event.type, "generate");
	assert.equal(event.request.requestId, dBody.requestId);
	assert.equal(event.request.idempotencyKey, `live:${dBody.requestId}`);
	assert.equal(event.request.inResponseTo, `live:${dBody.requestId}`);
	assert.equal(event.request.blockRef, "b123456");
	assert.equal(event.request.baseRevision, 0);
	assert.equal(event.request.instruction, "make this concise");
});

test("R8 — one outstanding request per session is enforced", async () => {
	// The prior test left a delivered (non-terminal) request outstanding.
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: "doc.md",
				kind: "steer",
				instruction: "second one",
			}),
		}),
	);
	assert.equal(res.status, 409);
	const body = (await res.json()) as { error: string };
	assert.equal(body.error, "OUTSTANDING_REQUEST");
});

test("R6 — agent reply 'stale' marks the request stale (fail closed)", async () => {
	const last = store.latestRequest(currentSession(wsA))!;
	const res = await replyPOST(
		new Request(agentUrl("/api/agent/live/reply", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({ requestId: last.id, status: "stale" }),
		}),
	);
	assert.equal(res.status, 200);
	assert.equal(store.getRequest(last.id)!.state, "stale");

	// Now a new generate is allowed (prior turn is terminal).
	const ok = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: "doc.md",
				blockRef: "b123456",
				baseRevision: 1,
				kind: "generate",
				instruction: "try again",
			}),
		}),
	);
	assert.equal(ok.status, 200);
});

test("R5 — accept notification resolves the request with outcome", async () => {
	const last = store.latestRequest(currentSession(wsA))!;
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "doc.md", kind: "accept", requestId: last.id }),
		}),
	);
	assert.equal(res.status, 200);
	const r = store.getRequest(last.id)!;
	assert.equal(r.state, "resolved");
	assert.equal(r.outcome, "accepted");
});

test("R7 — replay: request id -> stable deterministic idempotency key", () => {
	const enq = store.enqueueRequest({
		sessionId: currentSession(wsA),
		workspaceId: wsA,
		path: "doc.md",
		kind: "generate",
		blockRef: "bZ",
		baseRevision: 2,
		instruction: "x",
	});
	assert.ok(enq.ok);
	const rid = enq.ok ? enq.request.id : "";
	// The key an agent must reuse across a crash/reconnect is derived from the id.
	assert.equal(`live:${rid}`, `live:${store.getRequest(rid)!.id}`);
});

test("R10 — workspace isolation: wsB poll never sees wsA requests", async () => {
	// Attach an agent session in wsB.
	await attachPOST(
		new Request(agentUrl("/api/agent/live/attach", wsB), {
			method: "POST",
			headers: agentHeaders(),
		}),
	);
	const sessionB = currentSession(wsB);
	// Poll wsB with a very short hold; there are no wsB requests, so it times out.
	const pollRes = await pollGET(
		new Request(agentUrl("/api/agent/live/poll", wsB, { sessionId: sessionB, afterSeq: "0", holdMs: "300" }), {
			headers: agentHeaders(),
		}),
	);
	const body = (await pollRes.json()) as { type: string };
	assert.equal(body.type, "timeout");
});

test("security — cross-workspace accept is rejected", async () => {
	// Clear any outstanding request left by earlier tests, then create one in wsA.
	const prior = store.latestRequest(currentSession(wsA));
	if (prior && ["pending", "delivered", "working"].includes(prior.state)) {
		store.markState(prior.id, "resolved", "accepted");
	}
	const enq = store.enqueueRequest({
		sessionId: currentSession(wsA),
		workspaceId: wsA,
		path: "doc.md",
		kind: "generate",
		blockRef: "bX",
		baseRevision: 3,
		instruction: "x",
	});
	assert.ok(enq.ok);
	const rid = enq.ok ? enq.request.id : "";
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsB), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "doc.md", kind: "accept", requestId: rid }),
		}),
	);
	assert.equal(res.status, 404);
	// The wsA request is untouched.
	assert.notEqual(store.getRequest(rid)!.state, "resolved");
});

test("recovery — a delivered-but-unreplied request is redelivered on reconnect", async () => {
	// Fresh session so no prior outstanding request interferes.
	const session = store.attachAgent(wsB, "ai:live-agent");
	const enq = store.enqueueRequest({
		sessionId: session.id,
		workspaceId: wsB,
		path: "doc.md",
		kind: "generate",
		blockRef: "bR",
		baseRevision: 0,
		instruction: "recover me",
	});
	assert.ok(enq.ok);
	const rid = enq.ok ? enq.request.id : "";
	// First poll delivers it (marks 'delivered').
	const first = await pollGET(
		new Request(agentUrl("/api/agent/live/poll", wsB, { sessionId: session.id, afterSeq: "0", holdMs: "500" }), {
			headers: agentHeaders(),
		}),
	);
	const firstBody = (await first.json()) as { type: string; request?: { requestId: string } };
	assert.equal(firstBody.type, "generate");
	assert.equal(firstBody.request!.requestId, rid);
	assert.equal(store.getRequest(rid)!.state, "delivered");
	// Agent "crashed" before replying; reconnect polls again with afterSeq=0 and
	// must receive the same request (redelivery of a delivered, unreplied request).
	const second = await pollGET(
		new Request(agentUrl("/api/agent/live/poll", wsB, { sessionId: session.id, afterSeq: "0", holdMs: "500" }), {
			headers: agentHeaders(),
		}),
	);
	const secondBody = (await second.json()) as { type: string; request?: { requestId: string } };
	assert.equal(secondBody.type, "generate");
	assert.equal(secondBody.request!.requestId, rid);
});

test("R2b — precise-pointing fields round-trip through poll; absent -> null", async () => {
	// Fresh session in wsB so no prior outstanding request interferes.
	const session = store.attachAgent(wsB, "ai:live-agent");
	const prior = store.latestRequest(session.id);
	if (prior && ["pending", "delivered", "working"].includes(prior.state)) {
		store.markState(prior.id, "resolved", "accepted");
	}

	// WITH selection context.
	const enqWith = store.enqueueRequest({
		sessionId: session.id,
		workspaceId: wsB,
		path: "doc.md",
		blockRef: "bSel",
		baseRevision: 0,
		kind: "generate",
		instruction: "tighten this",
		selectionText: "exact highlighted words",
		selectionStart: 5,
		selectionEnd: 28,
	});
	assert.ok(enqWith.ok);
	const withSeq = enqWith.ok ? enqWith.request.seq : 0;

	const withRes = await pollGET(
		new Request(
			agentUrl("/api/agent/live/poll", wsB, {
				sessionId: session.id,
				afterSeq: "0",
				holdMs: "500",
			}),
			{ headers: agentHeaders() },
		),
	);
	const withEvent = (await withRes.json()) as {
		request: {
			selectionText: string | null;
			selectionStart: number | null;
			selectionEnd: number | null;
		};
	};
	assert.equal(withEvent.request.selectionText, "exact highlighted words");
	assert.equal(withEvent.request.selectionStart, 5);
	assert.equal(withEvent.request.selectionEnd, 28);

	// Resolve it so the next generate is not blocked by one-outstanding rule.
	if (enqWith.ok) store.markState(enqWith.request.id, "resolved");

	// WITHOUT selection context -> null at enqueue and echoed back over poll.
	const enqNone = store.enqueueRequest({
		sessionId: session.id,
		workspaceId: wsB,
		path: "doc.md",
		blockRef: "bNone",
		baseRevision: 0,
		kind: "generate",
		instruction: "no selection",
	});
	assert.ok(enqNone.ok);
	if (enqNone.ok) {
		assert.equal(enqNone.request.selectionText, null);
		assert.equal(enqNone.request.selectionStart, null);
		assert.equal(enqNone.request.selectionEnd, null);
	}

	const noneRes = await pollGET(
		new Request(
			agentUrl("/api/agent/live/poll", wsB, {
				sessionId: session.id,
				afterSeq: String(withSeq),
				holdMs: "500",
			}),
			{ headers: agentHeaders() },
		),
	);
	const noneEvent = (await noneRes.json()) as {
		request: {
			selectionText: string | null;
			selectionStart: number | null;
			selectionEnd: number | null;
		};
	};
	assert.equal(noneEvent.request.selectionText, null);
	assert.equal(noneEvent.request.selectionStart, null);
	assert.equal(noneEvent.request.selectionEnd, null);

	if (enqNone.ok) store.markState(enqNone.request.id, "resolved");
});

test("R9 — presence timeout reports detached", () => {
	const session = store.latestOpenSession(wsA)!;
	// Force agent_last_seen far in the past by re-deriving isAttached on a stale copy.
	const stale = { ...session, agentLastSeen: Date.now() - store.PRESENCE_TTL_MS - 1000 };
	assert.equal(store.isAttached(stale), false);
});

test("R5-batch — collective 'Send to agent' dispatches one run with N items", async () => {
	const session = store.attachAgent(wsB, "ai:live-agent");
	const prior = store.latestRequest(session.id);
	if (prior && ["pending", "delivered", "working"].includes(prior.state)) {
		store.markState(prior.id, "resolved", "accepted");
	}

	const dispatch = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsB), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: "doc.md",
				kind: "generate",
				items: [
					{ instructionId: "c001", blockRef: "bA", baseRevision: 0, instruction: "tighten intro" },
					{ instructionId: "c002", blockRef: "bB", baseRevision: 0, instruction: "add example" },
				],
			}),
		}),
	);
	assert.equal(dispatch.status, 200);
	const body = (await dispatch.json()) as { requestId: string; runId: string | null };
	assert.ok(body.runId, "batch dispatch returns a runId");

	const pollRes = await pollGET(
		new Request(
			agentUrl("/api/agent/live/poll", wsB, {
				sessionId: session.id,
				afterSeq: "0",
				holdMs: "500",
			}),
			{ headers: agentHeaders() },
		),
	);
	const event = (await pollRes.json()) as {
		type: string;
		request: {
			runId: string | null;
			items: Array<{ instructionId: string; instruction: string; blockRef: string | null }> | null;
		};
	};
	assert.equal(event.type, "generate");
	assert.equal(event.request.runId, body.runId);
	assert.ok(event.request.items && event.request.items.length === 2);
	assert.equal(event.request.items?.[0].instructionId, "c001");
	assert.equal(event.request.items?.[1].blockRef, "bB");

	store.markState(body.requestId, "resolved", "accepted");
});

test("R5-batch — malformed items rejected 400", async () => {
	const session = store.attachAgent(wsB, "ai:live-agent");
	const prior = store.latestRequest(session.id);
	if (prior && ["pending", "delivered", "working"].includes(prior.state)) {
		store.markState(prior.id, "resolved", "accepted");
	}
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/live/request", wsB), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: "doc.md",
				kind: "generate",
				items: [{ instructionId: "x", blockRef: "b" }],
			}),
		}),
	);
	assert.equal(res.status, 400);
});

// Helper: the current open session id for a workspace.
function currentSession(ws: string): string {
	const s = store.latestOpenSession(ws);
	assert.ok(s, `expected open session for ${ws}`);
	return s!.id;
}
