/**
 * Tests for the pure register() function in register.ts.
 * Uses a mock fetch — no real wiki-viewer instance needed.
 *
 * Run: tsx --test src/__tests__/register.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  register,
  RegistrationDeniedError,
  RegistrationExpiredError,
  RegistrationTimeoutError,
} from "../register.js";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockResponse {
  status: number;
  body?: Record<string, unknown> | string;
}

function makeFetch(responses: MockResponse[]) {
  let idx = 0;
  return async (_url: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const resp = responses[idx++];
    if (!resp) throw new Error(`Unexpected fetch call #${idx} (only ${responses.length} mocked)`);

    let bodyInit: BodyInit;
    const headers = new Headers({ "Content-Type": "application/json" });
    if (typeof resp.body === "string") {
      bodyInit = resp.body;
    } else if (resp.body !== undefined) {
      bodyInit = JSON.stringify(resp.body);
    } else {
      bodyInit = "";
    }
    return new Response(bodyInit, { status: resp.status, headers });
  };
}

const BASE_OPTS = {
  baseUrl: "http://localhost:3000",
  id: "ai:testbot",
  displayName: "Test Bot",
  scope: { paths: ["**/*"], ops: ["read", "mutate"] as Array<"read" | "mutate" | "delete"> },
  pollIntervalMs: 0, // no real delay in tests
};

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("register — happy path", () => {
  test("pending → approved returns token and agentId", async () => {
    const fetch = makeFetch([
      // POST /api/agent/register → 200 pending
      {
        status: 200,
        body: { registrationId: "reg-abc", pollUrl: "/api/agent/register/reg-abc", status: "pending" },
      },
      // Poll #1 → 202 still pending
      { status: 202, body: { status: "pending" } },
      // Poll #2 → 200 approved
      { status: 200, body: { status: "approved", agentId: "ai:testbot", token: "tok-xyz" } },
    ]);

    const result = await register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch });

    assert.equal(result.token, "tok-xyz");
    assert.equal(result.agentId, "ai:testbot");
  });

  test("immediately approved (first poll)", async () => {
    const fetch = makeFetch([
      { status: 200, body: { registrationId: "reg-1", pollUrl: "/api/agent/register/reg-1", status: "pending" } },
      { status: 200, body: { status: "approved", agentId: "ai:testbot", token: "tok-immediate" } },
    ]);

    const result = await register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch });
    assert.equal(result.token, "tok-immediate");
  });

  test("onPending callback fires on 202 responses", async () => {
    const pendingCalls: Array<[string, number]> = [];

    const fetch = makeFetch([
      { status: 200, body: { registrationId: "reg-cb", pollUrl: "/api/agent/register/reg-cb", status: "pending" } },
      { status: 202, body: { status: "pending" } },
      { status: 202, body: { status: "pending" } },
      { status: 200, body: { status: "approved", agentId: "ai:testbot", token: "tok-cb" } },
    ]);

    await register({
      ...BASE_OPTS,
      fetch: fetch as unknown as typeof globalThis.fetch,
      onPending: (id, attempt) => pendingCalls.push([id, attempt]),
    });

    assert.equal(pendingCalls.length, 2, "callback fires for each 202");
    assert.equal(pendingCalls[0]![0], "reg-cb");
    assert.equal(pendingCalls[0]![1], 1);
    assert.equal(pendingCalls[1]![1], 2);
  });

  test("absolute pollUrl is used as-is", async () => {
    const visitedUrls: string[] = [];
    const fetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      visitedUrls.push(url.toString());
      if ((init?.method ?? "GET") === "POST") {
        return new Response(
          JSON.stringify({ registrationId: "r", pollUrl: "http://other.host/poll/r", status: "pending" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ status: "approved", agentId: "ai:testbot", token: "t" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    await register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch });
    assert.ok(visitedUrls.some((u) => u === "http://other.host/poll/r"), "absolute pollUrl used verbatim");
  });
});

// ─── Denied ───────────────────────────────────────────────────────────────────

describe("register — denied", () => {
  test("200 denied status throws RegistrationDeniedError", async () => {
    const fetch = makeFetch([
      { status: 200, body: { registrationId: "r", pollUrl: "/api/agent/register/r", status: "pending" } },
      { status: 200, body: { status: "denied" } },
    ]);

    await assert.rejects(
      () => register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch }),
      RegistrationDeniedError,
    );
  });

  test("410 throws RegistrationDeniedError", async () => {
    const fetch = makeFetch([
      { status: 200, body: { registrationId: "r", pollUrl: "/api/agent/register/r", status: "pending" } },
      { status: 410, body: { status: "consumed" } },
    ]);

    await assert.rejects(
      () => register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch }),
      RegistrationDeniedError,
    );
  });
});

// ─── Expired ─────────────────────────────────────────────────────────────────

describe("register — expired", () => {
  test("404 on poll throws RegistrationExpiredError", async () => {
    const fetch = makeFetch([
      { status: 200, body: { registrationId: "r", pollUrl: "/api/agent/register/r", status: "pending" } },
      { status: 404, body: {} },
    ]);

    await assert.rejects(
      () => register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch }),
      RegistrationExpiredError,
    );
  });
});

// ─── Timeout ─────────────────────────────────────────────────────────────────

describe("register — timeout", () => {
  test("throws RegistrationTimeoutError when deadline exceeded", async () => {
    // timeoutMs=0 means the deadline is already past after the first sleep(0)
    const responses: MockResponse[] = [
      { status: 200, body: { registrationId: "r", pollUrl: "/api/agent/register/r", status: "pending" } },
      // Provide many 202s so the test loop exits by timeout not by running out of responses
      ...Array.from({ length: 20 }, () => ({ status: 202, body: { status: "pending" } })),
    ];

    const fetch = makeFetch(responses);

    await assert.rejects(
      () =>
        register({
          ...BASE_OPTS,
          fetch: fetch as unknown as typeof globalThis.fetch,
          timeoutMs: 0,  // already expired
          pollIntervalMs: 0,
        }),
      RegistrationTimeoutError,
    );
  });
});

// ─── Registration POST failure ────────────────────────────────────────────────

describe("register — POST failure", () => {
  test("non-200 on POST throws generic Error", async () => {
    const fetch = makeFetch([
      { status: 400, body: "invalid id" },
    ]);

    await assert.rejects(
      () => register({ ...BASE_OPTS, fetch: fetch as unknown as typeof globalThis.fetch }),
      (e: unknown) => e instanceof Error && (e as Error).message.includes("400"),
    );
  });
});
