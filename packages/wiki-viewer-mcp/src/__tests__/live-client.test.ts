/**
 * Unit tests for live-client.ts (agent-side live runtime). Mock fetch only.
 *
 * Run: tsx --test src/__tests__/live-client.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LiveClient,
  runLiveLoop,
  StaleRequestError,
  LiveError,
  type LiveRequest,
} from "../live-client.js";

// ─── Mock transport ────────────────────────────────────────────────────────────

interface Route {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => { status: number; body?: unknown };
}

function makeFetch(routes: Route[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) throw new Error(`No mock route for ${init?.method ?? "GET"} ${url}`);
    const { status, body } = route.respond(url, init);
    const headers = new Headers({ "Content-Type": "application/json" });
    return new Response(body !== undefined ? JSON.stringify(body) : "", { status, headers });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const cfg = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://wiki.test",
  token: "tok",
  agentId: "ai:tester",
  workspace: "ws1",
  fetch: fetchImpl,
});

function liveRequest(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return {
    requestId: "lr_1",
    sessionId: "ls_1",
    path: "notes/doc.md",
    blockRef: "b7f2c1",
    baseRevision: 4,
    kind: "generate",
    instruction: "make it punchier",
    selectionText: "exact highlighted words",
    selectionStart: 5,
    selectionEnd: 28,
    seq: 1,
    idempotencyKey: "live:lr_1",
    inResponseTo: "live:lr_1",
    ...overrides,
  };
}

// ─── attach ─────────────────────────────────────────────────────────────────────

test("attach posts to /attach and returns sessionId with workspace header", async () => {
  const { fetch, calls } = makeFetch([
    {
      match: (u) => u.endsWith("/api/agent/live/attach"),
      respond: () => ({ status: 200, body: { sessionId: "ls_9", workspaceId: "ws1" } }),
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  const id = await client.attach();
  assert.equal(id, "ls_9");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["X-Workspace"], "ws1");
  assert.equal(headers["Authorization"], "Bearer tok");
});

// ─── applyTier2Ops: idempotency + correlation + fail-closed ─────────────────────

test("applyTier2Ops sends live idempotency key and stamps inResponseTo", async () => {
  let sentBody: Record<string, unknown> | undefined;
  let sentKey: string | undefined;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: (_u, i) => {
        sentBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        sentKey = ((i?.headers ?? {}) as Record<string, string>)["Idempotency-Key"];
        return { status: 200, body: { path: "notes/doc.md", revision: 5, blocks: [], lastEventId: 1 } };
      },
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  const snap = await client.applyTier2Ops(liveRequest(), [
    { type: "block.replace", ref: "b7f2c1", markdown: "Punchier." },
  ]);
  assert.equal(snap.revision, 5);
  assert.equal(sentKey, "live:lr_1");
  assert.equal(sentBody?.baseRevision, 4);
  assert.equal(sentBody?.by, "ai:tester");
  const ops = sentBody?.ops as Array<Record<string, unknown>>;
  assert.equal(ops[0].inResponseTo, "live:lr_1");
  assert.equal(ops[0].markdown, "Punchier.");
});

test("applyTier2Ops ignores handler-supplied inResponseTo/idempotency overrides", async () => {
  let sentBody: Record<string, unknown> | undefined;
  let sentKey: string | undefined;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: (_u, i) => {
        sentBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        sentKey = ((i?.headers ?? {}) as Record<string, string>)["Idempotency-Key"];
        return { status: 200, body: { path: "notes/doc.md", revision: 5, blocks: [], lastEventId: 1 } };
      },
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  // Malicious/mistaken handler tries to override correlation.
  await client.applyTier2Ops(liveRequest(), [
    { type: "block.replace", ref: "b7f2c1", markdown: "x", inResponseTo: "live:HIJACK" },
  ]);
  assert.equal(sentKey, "live:lr_1");
  const ops = sentBody?.ops as Array<Record<string, unknown>>;
  assert.equal(ops[0].inResponseTo, "live:lr_1");
});

test("applyTier2Ops throws StaleRequestError on 409 STALE_REVISION (fail closed)", async () => {
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: () => ({
        status: 409,
        body: { error: "STALE_REVISION", snapshot: { revision: 7 } },
      }),
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  await assert.rejects(
    () => client.applyTier2Ops(liveRequest(), [{ type: "block.replace", ref: "b7f2c1", markdown: "x" }]),
    (e: unknown) => e instanceof StaleRequestError && e.newRevision === 7,
  );
});

test("applyTier2Ops rejects a request without baseRevision", async () => {
  const { fetch } = makeFetch([]);
  const client = new LiveClient(cfg(fetch));
  await assert.rejects(
    () => client.applyTier2Ops(liveRequest({ baseRevision: null }), []),
    (e: unknown) => e instanceof LiveError && e.code === "NO_BASE_REVISION",
  );
});

// ─── runLiveLoop end-to-end (mocked) ────────────────────────────────────────────

test("runLiveLoop: attach → deliver → edit → reply done, then abort on timeout", async () => {
  const controller = new AbortController();
  const replies: Array<{ requestId: string; status: string }> = [];
  let polls = 0;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.endsWith("/api/agent/live/attach") && i?.method === "POST",
      respond: () => ({ status: 200, body: { sessionId: "ls_1", workspaceId: "ws1" } }),
    },
    {
      match: (u) => u.includes("/api/agent/live/poll"),
      respond: () => {
        polls += 1;
        if (polls === 1) return { status: 200, body: { type: "generate", request: liveRequest() } };
        // Second poll: stop the loop.
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u) => u.endsWith("/api/agent/live/reply"),
      respond: (_u, i) => {
        replies.push(JSON.parse(String(i?.body)) as { requestId: string; status: string });
        return { status: 200, body: { ok: true } };
      },
    },
    {
      // snapshot GET (prefetch)
      match: (u, i) => u.includes("/api/agent/files/") && (i?.method ?? "GET") === "GET",
      respond: () => ({ status: 200, body: { path: "notes/doc.md", revision: 4, blocks: [], lastEventId: 0 } }),
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: () => ({ status: 200, body: { path: "notes/doc.md", revision: 5, blocks: [], lastEventId: 1 } }),
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  const events: string[] = [];
  await runLiveLoop(
    client,
    async (req) => [{ type: "block.replace", ref: req.blockRef!, markdown: "edited" }],
    { signal: controller.signal, onEvent: (e) => events.push(e) },
  );

  assert.deepEqual(
    replies.map((r) => r.status),
    ["working", "done"],
  );
  assert.ok(events.includes("attached"));
  assert.ok(events.includes("done"));
});

test("runLiveLoop: handler receives precise-pointing fields on req", async () => {
  const controller = new AbortController();
  let seen: LiveRequest | undefined;
  let polls = 0;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.endsWith("/api/agent/live/attach") && i?.method === "POST",
      respond: () => ({ status: 200, body: { sessionId: "ls_1", workspaceId: "ws1" } }),
    },
    {
      match: (u) => u.includes("/api/agent/live/poll"),
      respond: () => {
        polls += 1;
        if (polls === 1)
          return {
            status: 200,
            body: {
              type: "generate",
              request: liveRequest({
                selectionText: "pointed substring",
                selectionStart: 12,
                selectionEnd: 29,
              }),
            },
          };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u) => u.endsWith("/api/agent/live/reply"),
      respond: () => ({ status: 200, body: { ok: true } }),
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && (i?.method ?? "GET") === "GET",
      respond: () => ({ status: 200, body: { path: "notes/doc.md", revision: 4, blocks: [], lastEventId: 0 } }),
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: () => ({ status: 200, body: { path: "notes/doc.md", revision: 5, blocks: [], lastEventId: 1 } }),
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(
    client,
    async (req) => {
      seen = req;
      return [{ type: "block.replace", ref: req.blockRef!, markdown: "edited" }];
    },
    { signal: controller.signal },
  );

  assert.equal(seen?.selectionText, "pointed substring");
  assert.equal(seen?.selectionStart, 12);
  assert.equal(seen?.selectionEnd, 29);
});

test("runLiveLoop: handler stale error maps to reply status 'stale'", async () => {
  const controller = new AbortController();
  const replies: string[] = [];
  let polls = 0;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.endsWith("/api/agent/live/attach") && i?.method === "POST",
      respond: () => ({ status: 200, body: { sessionId: "ls_1" } }),
    },
    {
      match: (u) => u.includes("/api/agent/live/poll"),
      respond: () => {
        polls += 1;
        if (polls === 1) return { status: 200, body: { type: "generate", request: liveRequest() } };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u) => u.endsWith("/api/agent/live/reply"),
      respond: (_u, i) => {
        replies.push((JSON.parse(String(i?.body)) as { status: string }).status);
        return { status: 200, body: { ok: true } };
      },
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && (i?.method ?? "GET") === "GET",
      respond: () => ({ status: 200, body: { path: "notes/doc.md", revision: 4, blocks: [], lastEventId: 0 } }),
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: () => ({ status: 409, body: { error: "STALE_REVISION", snapshot: { revision: 9 } } }),
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(
    client,
    async (req) => [{ type: "block.replace", ref: req.blockRef!, markdown: "late" }],
    { signal: controller.signal },
  );

  assert.deepEqual(replies, ["working", "stale"]);
});

test("runLiveLoop: control-kind notification (accept) does not edit or reply", async () => {
  const controller = new AbortController();
  let edits = 0;
  let polls = 0;
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.endsWith("/api/agent/live/attach") && i?.method === "POST",
      respond: () => ({ status: 200, body: { sessionId: "ls_1" } }),
    },
    {
      match: (u) => u.includes("/api/agent/live/poll"),
      respond: () => {
        polls += 1;
        if (polls === 1)
          return { status: 200, body: { type: "accept", request: liveRequest({ kind: "accept" }) } };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u, i) => u.includes("/api/agent/files/") && i?.method === "POST",
      respond: () => {
        edits += 1;
        return { status: 200, body: {} };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  const events: string[] = [];
  await runLiveLoop(client, async () => [{ type: "block.append", markdown: "x" }], {
    signal: controller.signal,
    onEvent: (e) => events.push(e),
  });

  assert.equal(edits, 0);
  assert.ok(events.includes("notification"));
});
