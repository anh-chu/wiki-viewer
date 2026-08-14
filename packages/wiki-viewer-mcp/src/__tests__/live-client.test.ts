/**
 * Unit tests for live-client.ts (agent-side live runtime). Mock fetch only.
 *
 * Run: tsx --test src/__tests__/live-client.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  LiveClient,
  runLiveLoop,
  StaleRequestError,
  LiveError,
  type LiveRequest,
} from "../live-client.js";
import { passthroughWebHandler } from "../cli.js";

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

test("runLiveLoop: batch items produce N ops in one correlated commit + one done", async () => {
  const controller = new AbortController();
  const replies: string[] = [];
  let sentBody: Record<string, unknown> | undefined;
  let sentKey: string | undefined;
  const handlerReqs: LiveRequest[] = [];
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
          return {
            status: 200,
            body: {
              type: "generate",
              request: liveRequest({
                runId: "run:abc123",
                items: [
                  { instructionId: "i1", blockRef: "b1", baseRevision: 4, instruction: "one" },
                  { instructionId: "i2", blockRef: "b2", baseRevision: 4, instruction: "two" },
                  { instructionId: "i3", blockRef: null, baseRevision: 4, instruction: "three" },
                ],
              }),
            },
          };
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
      respond: (_u, i) => {
        sentBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        sentKey = ((i?.headers ?? {}) as Record<string, string>)["Idempotency-Key"];
        return { status: 200, body: { path: "notes/doc.md", revision: 5, blocks: [], lastEventId: 1 } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(
    client,
    async (req) => {
      handlerReqs.push(req);
      return req.blockRef
        ? [{ type: "block.replace", ref: req.blockRef, markdown: req.instruction ?? "" }]
        : [{ type: "block.append", markdown: req.instruction ?? "" }];
    },
    { signal: controller.signal },
  );

  // Handler called once per item with the item's own fields.
  assert.equal(handlerReqs.length, 3);
  assert.deepEqual(handlerReqs.map((r) => r.instruction), ["one", "two", "three"]);
  assert.equal(handlerReqs[2].blockRef, null);
  // One commit carrying all 3 ops, single correlation key.
  const ops = sentBody?.ops as Array<Record<string, unknown>>;
  assert.equal(ops.length, 3);
  assert.equal(sentKey, "live:lr_1");
  for (const op of ops) assert.equal(op.inResponseTo, "live:lr_1");
  // runId stamped into provenance for run grouping.
  assert.ok(String(ops[0].basisDetail).includes("run:abc123"));
  // One lifecycle: working then done for the whole run.
  assert.deepEqual(replies, ["working", "done"]);
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

// ─── web.tweak: submitWebPreview + runLiveLoop dispatch ──────────────────────────

function webTweakRequest(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return liveRequest({
    kind: "web.tweak",
    baseRevision: null,
    blockRef: null,
    instruction: "make it red",
    selectionText: JSON.stringify({
      previewId: "wp_1",
      selector: "#hero",
      tag: "div",
      snippet: "<div id=hero>",
    }),
    ...overrides,
  });
}

test("submitWebPreview posts body+headers to /web-preview and stamps status", async () => {
  let sentBody: Record<string, unknown> | undefined;
  let sentUrl = "";
  let sentHeaders: Record<string, string> = {};
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (u, i) => {
        sentUrl = u;
        sentBody = JSON.parse(String(i?.body)) as Record<string, unknown>;
        sentHeaders = (i?.headers ?? {}) as Record<string, string>;
        return { status: 200, body: { ok: true, status: "preview-ready", previewId: "wp_1" } };
      },
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  await client.submitWebPreview({
    previewId: "wp_1",
    requestId: "lr_1",
    domPreviewOps: [{ type: "setText", value: "hi" }],
    candidateSourcePatch: null,
    baseFiles: [],
    status: "done",
  });
  assert.ok(sentUrl.includes("ws=ws1"));
  assert.equal(sentHeaders["X-Workspace"], "ws1");
  assert.equal(sentHeaders["Authorization"], "Bearer tok");
  assert.equal(sentBody?.previewId, "wp_1");
  assert.equal(sentBody?.requestId, "lr_1");
  assert.equal(sentBody?.status, "done");
  const ops = sentBody?.domPreviewOps as Array<Record<string, unknown>>;
  assert.equal(ops[0].type, "setText");
});

test("submitWebPreview throws LiveError with parsed code on non-2xx", async () => {
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: () => ({ status: 404, body: { error: "PREVIEW_NOT_FOUND" } }),
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  await assert.rejects(
    () =>
      client.submitWebPreview({
        previewId: "wp_x",
        requestId: "lr_1",
        domPreviewOps: null,
        candidateSourcePatch: null,
        baseFiles: [],
        status: "done",
      }),
    (e: unknown) => e instanceof LiveError && e.code === "PREVIEW_NOT_FOUND",
  );
});

test("runLiveLoop: web.tweak invokes webHandler and submits its result done", async () => {
  const controller = new AbortController();
  const replies: string[] = [];
  let submitted: Record<string, unknown> | undefined;
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
          return { status: 200, body: { type: "web.tweak", request: webTweakRequest() } };
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
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (_u, i) => {
        submitted = JSON.parse(String(i?.body)) as Record<string, unknown>;
        return { status: 200, body: { ok: true, status: "preview-ready" } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  let seenCtx: unknown;
  await runLiveLoop(client, async () => null, {
    signal: controller.signal,
    webHandler: async (ctx) => {
      seenCtx = ctx;
      return {
        domPreviewOps: [{ type: "setStyle", prop: "color", value: "red" }],
        candidateSourcePatch: null,
        baseFiles: [],
      };
    },
  });

  assert.deepEqual(replies, ["working"]);
  assert.equal((seenCtx as { previewId: string }).previewId, "wp_1");
  assert.equal((seenCtx as { note: string }).note, "make it red");
  assert.equal(submitted?.status, "done");
  assert.equal(submitted?.previewId, "wp_1");
  const ops = submitted?.domPreviewOps as Array<Record<string, unknown>>;
  assert.equal(ops[0].type, "setStyle");
});

test("runLiveLoop: web.tweak handler throw submits status error", async () => {
  const controller = new AbortController();
  let submitted: Record<string, unknown> | undefined;
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
          return { status: 200, body: { type: "web.tweak", request: webTweakRequest() } };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u) => u.endsWith("/api/agent/live/reply"),
      respond: () => ({ status: 200, body: { ok: true } }),
    },
    {
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (_u, i) => {
        submitted = JSON.parse(String(i?.body)) as Record<string, unknown>;
        return { status: 200, body: { ok: true } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(client, async () => null, {
    signal: controller.signal,
    webHandler: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(submitted?.status, "error");
  assert.equal(submitted?.candidateSourcePatch, null);
});

test("runLiveLoop: web.tweak with no webHandler submits status error", async () => {
  const controller = new AbortController();
  let submitted: Record<string, unknown> | undefined;
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
          return { status: 200, body: { type: "web.tweak", request: webTweakRequest() } };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (_u, i) => {
        submitted = JSON.parse(String(i?.body)) as Record<string, unknown>;
        return { status: 200, body: { ok: true } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(client, async () => null, { signal: controller.signal });
  assert.equal(submitted?.status, "error");
});

// ─── web.tweak.variants: submitWebVariants + runLiveLoop dispatch ────────────────

function webVariantsRequest(overrides: Partial<LiveRequest> = {}): LiveRequest {
  return webTweakRequest({ kind: "web.tweak.variants", ...overrides });
}

test("runLiveLoop: web.tweak.variants invokes handler and submits N variants done", async () => {
  const controller = new AbortController();
  const replies: string[] = [];
  let submitted: Record<string, unknown> | undefined;
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
          return { status: 200, body: { type: "web.tweak.variants", request: webVariantsRequest() } };
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
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (_u, i) => {
        submitted = JSON.parse(String(i?.body)) as Record<string, unknown>;
        return { status: 200, body: { ok: true, status: "preview-ready" } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  let seenCtx: unknown;
  await runLiveLoop(client, async () => null, {
    signal: controller.signal,
    webVariantsHandler: async (ctx) => {
      seenCtx = ctx;
      return {
        variants: [
          {
            variantId: "v1",
            label: "red",
            domPreviewOps: [{ type: "setStyle", prop: "color", value: "red" }],
            candidateSourcePatch: null,
            baseFiles: [],
          },
          {
            variantId: "v2",
            label: "blue",
            domPreviewOps: [{ type: "setStyle", prop: "color", value: "blue" }],
            candidateSourcePatch: null,
            baseFiles: [],
          },
        ],
      };
    },
  });

  assert.deepEqual(replies, ["working"]);
  assert.equal((seenCtx as { previewId: string }).previewId, "wp_1");
  assert.equal(submitted?.status, "done");
  assert.equal(submitted?.previewId, "wp_1");
  assert.equal(submitted?.requestId, "lr_1");
  const variants = submitted?.variants as Array<Record<string, unknown>>;
  assert.equal(variants.length, 2);
  assert.equal(variants[0].variantId, "v1");
  assert.equal(variants[1].variantId, "v2");
});

test("runLiveLoop: web.tweak.variants with no handler submits status error", async () => {
  const controller = new AbortController();
  let submitted: Record<string, unknown> | undefined;
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
          return { status: 200, body: { type: "web.tweak.variants", request: webVariantsRequest() } };
        controller.abort();
        return { status: 200, body: { type: "timeout" } };
      },
    },
    {
      match: (u, i) => u.includes("/api/agent/live/web-preview") && i?.method === "POST",
      respond: (_u, i) => {
        submitted = JSON.parse(String(i?.body)) as Record<string, unknown>;
        return { status: 200, body: { ok: true } };
      },
    },
  ]);

  const client = new LiveClient(cfg(fetch));
  await runLiveLoop(client, async () => null, { signal: controller.signal });
  assert.equal(submitted?.status, "error");
});

test("passthroughWebHandler real-candidate path computes baseFiles via fetchFileForHash", async () => {
  const fileContent = "# Title\n\nbody text\n";
  const { fetch } = makeFetch([
    {
      match: (u, i) => u.includes("/api/agent/fs/file/") && (i?.method ?? "GET") === "GET",
      respond: () => ({ status: 200, body: fileContent }),
    },
  ]);
  const client = new LiveClient(cfg(fetch));
  const result = await passthroughWebHandler(
    {
      previewId: "wp_1",
      selector: "#hero",
      tag: "div",
      snippet: "<div>",
      note: "commit: add footnote",
      path: "page.html",
    },
    { client },
  );
  assert.ok(result.candidateSourcePatch);
  assert.equal(result.candidateSourcePatch?.files[0].path, "page.html");
  assert.equal(result.baseFiles.length, 1);
  assert.equal(result.baseFiles[0].path, "page.html");
  // sha256 of the exact fetched content.
  const expected = createHash("sha256").update(JSON.stringify(fileContent), "utf8").digest("hex");
  // The mock serializes the string body as JSON; fetchFileForHash reads res.text()
  // which is the JSON-encoded string. Assert hash matches that exact text.
  assert.equal(result.baseFiles[0].sha256, expected);
});
