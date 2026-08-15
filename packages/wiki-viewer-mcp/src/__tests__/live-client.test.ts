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

test("applyTier2Ops sends live idempotency key and omits inResponseTo", async () => {
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
  assert.equal(ops[0].inResponseTo, undefined);
  assert.equal(ops[0].markdown, "Punchier.");
});

test("applyTier2Ops accepts handler-supplied inResponseTo as ignored wire field", async () => {
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
  await client.applyTier2Ops(liveRequest(), [
    { type: "block.replace", ref: "b7f2c1", markdown: "x", inResponseTo: "live:legacy" },
  ]);
  assert.equal(sentKey, "live:lr_1");
  const ops = sentBody?.ops as Array<Record<string, unknown>>;
  assert.equal(ops[0].inResponseTo, undefined);
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

