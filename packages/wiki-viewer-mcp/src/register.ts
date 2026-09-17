/**
 * Registration flow for wiki-viewer.
 *
 * Pure function `register()` is testable with a mock fetch.
 * The CLI wrapper lives in index.ts.
 *
 * Two flows:
 *  1. Service-token bootstrap (preferred): pass `serviceToken`.
 *     POST /api/agent/register with X-Service-Token → 200 {token, agentId}
 *     immediately — no polling, no human approval.
 *  2. TOFU fallback: no serviceToken.
 *     POST /api/agent/register  → {registrationId, pollUrl, status:"pending"}
 *     human approves in AI Panel
 *     GET <pollUrl>             → 202 pending | 200 approved | 410 denied | 404 expired
 *     returns {token, agentId}
 */

export interface RegisterScope {
  paths: string[];
  ops: Array<"read" | "mutate" | "delete">;
}

export interface RegisterOptions {
  baseUrl: string;
  id: string;           // must match ^ai:[a-z][a-z0-9-]{0,30}$
  displayName: string;
  scope: RegisterScope;
  /**
   * Service token (from WIKI_VIEWER_SERVICE_TOKEN or ~/.wiki-viewer/service-token).
   * When set, registration is auto-approved server-side and the token comes
   * back in the initial response — no polling, no human approval.
   */
  serviceToken?: string;
  /** Override fetch for testing */
  fetch?: typeof globalThis.fetch;
  /** How long to wait between polls (ms, default 3000) */
  pollIntervalMs?: number;
  /** Total time to wait before giving up (ms, default 300_000) */
  timeoutMs?: number;
  /** Called each time we get a "pending" poll response */
  onPending?: (registrationId: string, attempt: number) => void;
}

export interface RegisterResult {
  token: string;
  agentId: string;
  /** Human-facing note from the operator's approval, e.g. token rotation. */
  warning?: string;
}

export async function register(opts: RegisterOptions): Promise<RegisterResult> {
  const _fetch = opts.fetch ?? globalThis.fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const base = opts.baseUrl.replace(/\/$/, "");

  // ── Step 1: POST registration ──────────────────────────────────────────────
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.serviceToken) headers["X-Service-Token"] = opts.serviceToken;

  const postRes = await _fetch(`${base}/api/agent/register`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      id: opts.id,
      displayName: opts.displayName,
      scope: opts.scope,
    }),
  });

  if (!postRes.ok) {
    const body = await postRes.text().catch(() => "");
    if (postRes.status === 401 && opts.serviceToken) {
      throw new Error(
        `Service token rejected (401). It may have been rotated — fetch the ` +
        `current token from wiki-viewer Settings → Service Token.`,
      );
    }
    throw new Error(`Registration request failed (${postRes.status}): ${body}`);
  }

  // ── Service-token bootstrap: token arrives in the initial response ─────────
  if (opts.serviceToken) {
    const body = await postRes.json() as {
      status: string;
      agentId?: string;
      token?: string;
      warning?: string;
    };
    if (body.status === "approved" && body.agentId && body.token) {
      return { token: body.token, agentId: body.agentId, warning: body.warning };
    }
    throw new Error(
      `Unexpected response to service-token registration: ${JSON.stringify(body)}`,
    );
  }

  const { registrationId, pollUrl } = await postRes.json() as {
    registrationId: string;
    pollUrl: string;
    status: string;
  };

  // Resolve pollUrl — may be absolute or relative
  const resolvedPollUrl = pollUrl.startsWith("http")
    ? pollUrl
    : `${base}${pollUrl.startsWith("/") ? "" : "/"}${pollUrl}`;

  // ── Step 2: Poll until approved / denied / timeout ─────────────────────────
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    attempt++;

    const pollRes = await _fetch(resolvedPollUrl);

    if (pollRes.status === 200) {
      const body = await pollRes.json() as {
        status: string;
        agentId?: string;
        token?: string;
        warning?: string;
      };
      if (body.status === "approved" && body.agentId && body.token) {
        return { token: body.token, agentId: body.agentId, warning: body.warning };
      }
      if (body.status === "denied") {
        throw new RegistrationDeniedError("Registration denied by the operator.");
      }
    } else if (pollRes.status === 202) {
      // Still pending — fire callback and loop
      opts.onPending?.(registrationId, attempt);
    } else if (pollRes.status === 410) {
      const body = await pollRes.json().catch(() => ({}) as Record<string, unknown>) as { status?: string };
      throw new RegistrationDeniedError(
        `Registration ${body.status ?? "denied/consumed"} — it can no longer be approved.`,
      );
    } else if (pollRes.status === 404) {
      throw new RegistrationExpiredError(
        "Registration expired (404). Try registering again.",
      );
    } else {
      throw new Error(`Unexpected poll status ${pollRes.status}.`);
    }
  }

  throw new RegistrationTimeoutError(
    `Timed out after ${Math.round(timeoutMs / 1000)}s. ` +
    `The request may still be pending in the wiki-viewer AI Panel (id: ${registrationId}).`,
  );
}

// ── Typed errors ──────────────────────────────────────────────────────────────

export class RegistrationDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationDeniedError";
  }
}

export class RegistrationExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationExpiredError";
  }
}

export class RegistrationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrationTimeoutError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
