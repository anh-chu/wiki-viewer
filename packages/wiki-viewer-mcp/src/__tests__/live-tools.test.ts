import { test } from "node:test";
import assert from "node:assert/strict";
import { WikiViewerClient } from "../http-client.js";
import { LiveClient } from "../live-client.js";
import { handleToolCall } from "../tool-handlers.js";

function setup() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); calls.push({ url, init });
    let body: unknown = {};
    if (url.endsWith("/attach")) body = { sessionId: "s1", workspaceId: "ws1" };
    if (url.includes("/poll")) body = { type: "timeout" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const cfg = { baseUrl: "https://wiki.test", token: "t", agentId: "ai:test", workspace: "ws1", fetch: fetcher };
  return { calls, client: new WikiViewerClient(cfg), live: new LiveClient(cfg) };
}

test("live_attach and live_poll use configured authenticated backend", async () => {
  const { calls, client, live } = setup();
  const attached = await handleToolCall(client, "live_attach", {}, live);
  assert.match(attached.content[0].text, /s1/);
  const polled = await handleToolCall(client, "live_poll", { sessionId: "s1", afterSeq: 0 }, live);
  assert.match(polled.content[0].text, /timeout/);
  assert.equal(((calls[0].init?.headers ?? {}) as Record<string, string>)["X-Agent-Id"], "ai:test");
});

test("live_submit_markdown rejects fewer than two variants", async () => {
  const { client, live } = setup();
  const result = await handleToolCall(client, "live_submit_markdown", {
    previewId: "p", requestId: "r", variants: [{ label: "one", markdown: "x" }],
  }, live);
  assert.match(result.content[0].text, /Invalid arguments/);
});
