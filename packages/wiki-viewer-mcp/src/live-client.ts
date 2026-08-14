/**
 * Agent-side runtime for wiki-viewer live collaboration.
 *
 * Contract: agents/wiki-viewer-skill/SKILL.md "Live collaboration" section.
 *
 * The live channel is a control plane only: it carries a human's block-scoped
 * instruction to an attached agent that holds a long-poll. The actual document
 * edit still flows through the ordinary Tier-2 path
 * (POST /api/agent/files/<path>.md) with the request's own baseRevision,
 * Idempotency-Key = live:<requestId>, and op.inResponseTo = live:<requestId>.
 *
 * This module never writes files itself except through applyTier2Ops, which is
 * the canonical commit path.
 */

// ─── Wire shapes ──────────────────────────────────────────────────────────────

export interface LiveConfig {
  baseUrl: string;
  token: string;
  agentId: string;
  /** Target workspace id (X-Workspace). Omit for single-workspace instances. */
  workspace?: string;
  fetch?: typeof fetch;
}

/** A generate/steer request pushed to the agent. */
export interface LiveRequest {
  requestId: string;
  sessionId: string;
  path: string;
  blockRef: string | null;
  baseRevision: number | null;
  kind: "generate" | "steer" | "accept" | "discard" | "exit";
  instruction: string | null;
  /** Exact substring the human highlighted within the block (context only). */
  selectionText?: string | null;
  /** Best-effort start char offset within block markdown (may be null). */
  selectionStart?: number | null;
  /** Best-effort end char offset (exclusive) within block markdown (may be null). */
  selectionEnd?: number | null;
  seq: number;
  /** "live:<requestId>" — pass verbatim as the Idempotency-Key on the edit. */
  idempotencyKey: string;
  /** "live:<requestId>" — pass verbatim as op.inResponseTo for correlation. */
  inResponseTo: string;
}

type PollResponse =
  | { type: "timeout" }
  | { type: "aborted" }
  | { type: LiveRequest["kind"]; request: LiveRequest };

export type ReplyStatus = "working" | "done" | "error" | "stale";

/** Minimal block-op shape for Tier-2 edits. */
export interface BlockOp {
  type:
    | "block.replace"
    | "block.insertAfter"
    | "block.insertBefore"
    | "block.delete"
    | "block.append"
    | "block.prepend";
  ref?: string;
  markdown?: string;
  basis?: "described" | "inferred" | "suggested";
  basisDetail?: string;
  inResponseTo?: string;
}

export interface SnapshotBlock {
  ref: string;
  type: string;
  markdown: string;
}

export interface Snapshot {
  path: string;
  revision: number;
  blocks: SnapshotBlock[];
  lastEventId: number;
}

export class LiveError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "LiveError";
  }
}

/** Thrown when a Tier-2 edit is rejected because the human moved on (fail closed). */
export class StaleRequestError extends LiveError {
  constructor(
    path: string,
    public readonly newRevision: number | null,
    body?: unknown,
  ) {
    super(409, "STALE_REVISION", `Live intent is stale for ${path} — reject, do not re-interpret`, body);
    this.name = "StaleRequestError";
  }
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class LiveClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly agentId: string;
  private readonly workspace?: string;
  private readonly _fetch: typeof fetch;

  constructor(config: LiveConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.agentId = config.agentId;
    this.workspace = config.workspace;
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "X-Agent-Id": this.agentId,
      ...(this.workspace ? { "X-Workspace": this.workspace } : {}),
      ...extra,
    };
  }

  private async parseError(res: Response): Promise<never> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => undefined);
    }
    const code =
      (body as Record<string, unknown> | undefined)?.error?.toString() ?? `HTTP_${res.status}`;
    throw new LiveError(res.status, code, `live ${res.status}: ${code}`, body);
  }

  /** Attach (idempotent per agent+workspace). Returns the session id. */
  async attach(): Promise<string> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/live/attach`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: "{}",
    });
    if (!res.ok) await this.parseError(res);
    const body = (await res.json()) as { sessionId: string };
    return body.sessionId;
  }

  /**
   * Long-poll for the next request. Held server-side up to ~25s (presence
   * signal). Returns the parsed poll response. `signal` lets the caller abort.
   */
  async poll(sessionId: string, afterSeq: number, opts: { signal?: AbortSignal; holdMs?: number } = {}): Promise<PollResponse> {
    const u = new URL(`${this.baseUrl}/api/agent/live/poll`);
    u.searchParams.set("sessionId", sessionId);
    u.searchParams.set("afterSeq", String(afterSeq));
    if (opts.holdMs !== undefined) u.searchParams.set("holdMs", String(opts.holdMs));
    const res = await this._fetch(u.toString(), {
      headers: this.headers(),
      signal: opts.signal,
    });
    if (!res.ok) await this.parseError(res);
    return (await res.json()) as PollResponse;
  }

  /** Report lifecycle status on a delivered request. */
  async reply(requestId: string, status: ReplyStatus): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/live/reply`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ requestId, status }),
    });
    if (!res.ok) await this.parseError(res);
  }

  /** Fetch the Tier-2 snapshot for a markdown file (blocks + revision). */
  async snapshot(path: string): Promise<Snapshot> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/files/${encodeFilePath(path)}`, {
      headers: this.headers(),
    });
    if (!res.ok) await this.parseError(res);
    return (await res.json()) as Snapshot;
  }

  /**
   * Apply Tier-2 block-ops through the canonical commit path, using the live
   * request's own baseRevision and idempotency key. Fails closed on a stale
   * revision: throws StaleRequestError instead of retrying against new content.
   */
  async applyTier2Ops(req: LiveRequest, ops: BlockOp[]): Promise<Snapshot> {
    if (req.baseRevision === null) {
      throw new LiveError(400, "NO_BASE_REVISION", `request ${req.requestId} has no baseRevision`);
    }
    // Derive correlation + idempotency from the request id at commit time — never
    // trust handler-supplied op.inResponseTo or the wire idempotencyKey field, so
    // crash dedupe and provenance linkage can't be broken by a mutated request.
    // Op spread comes first, then the stamp overrides.
    const correlation = `live:${req.requestId}`;
    const stampedOps = ops.map((op) => ({ ...op, inResponseTo: correlation }));
    const res = await this._fetch(`${this.baseUrl}/api/agent/files/${encodeFilePath(req.path)}`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "Idempotency-Key": correlation,
      }),
      body: JSON.stringify({
        baseRevision: req.baseRevision,
        by: this.agentId,
        ops: stampedOps,
      }),
    });
    if (res.status === 409) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      const b = body as { error?: string; snapshot?: { revision?: number } } | undefined;
      if (b?.error === "STALE_REVISION") {
        throw new StaleRequestError(req.path, b.snapshot?.revision ?? null, body);
      }
      throw new LiveError(409, b?.error ?? "CONFLICT", `live edit conflict for ${req.path}`, body);
    }
    if (!res.ok) await this.parseError(res);
    return (await res.json()) as Snapshot;
  }
}

// ─── Runtime loop ─────────────────────────────────────────────────────────────

/**
 * Decides what to do with one delivered generate/steer request. Return the
 * block-ops to apply, or null to skip the edit (still marks the request done).
 * Throw StaleRequestError-agnostic errors freely; the loop maps them to reply
 * status. `snapshot` is provided pre-fetched at the request's revision for
 * convenience. It is fetched at handling time so it may be newer than the
 * request's baseRevision; the edit still commits at req.baseRevision and fails
 * closed if the human moved on. May be undefined if the fetch failed.
 */
export type LiveHandler = (
  req: LiveRequest,
  ctx: { client: LiveClient; snapshot?: Snapshot },
) => Promise<BlockOp[] | null>;

export interface RunLiveLoopOptions {
  signal?: AbortSignal;
  /** Called on each accepted request lifecycle transition (for logging). */
  onEvent?: (event: string, detail?: unknown) => void;
  /** Prefetch the snapshot before invoking the handler. Default true. */
  prefetchSnapshot?: boolean;
}

/**
 * Attach and process live requests until aborted. One outstanding request at a
 * time is enforced server-side; this loop honors that by handling sequentially.
 */
export async function runLiveLoop(
  client: LiveClient,
  handler: LiveHandler,
  opts: RunLiveLoopOptions = {},
): Promise<void> {
  const log = opts.onEvent ?? (() => {});
  const prefetch = opts.prefetchSnapshot ?? true;
  let sessionId = await client.attach();
  log("attached", { sessionId });
  let afterSeq = 0;

  while (!opts.signal?.aborted) {
    let res: PollResponse;
    try {
      res = await client.poll(sessionId, afterSeq, { signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) break;
      if ((e as Error).name === "AbortError") break;
      // Session evaporated (server restart / presence expiry) — re-attach and
      // resume from seq 0 against the fresh session.
      if (e instanceof LiveError && e.status === 404) {
        log("reattach", { reason: e.code });
        sessionId = await client.attach();
        afterSeq = 0;
        log("attached", { sessionId });
        continue;
      }
      log("poll-error", { error: (e as Error).message });
      await sleep(1000);
      continue;
    }

    if (res.type === "timeout" || res.type === "aborted") {
      continue;
    }

    const req = res.request;
    afterSeq = req.seq;

    // Control-only kinds (accept/discard/exit) are notifications; no edit.
    if (req.kind !== "generate" && req.kind !== "steer") {
      log("notification", { kind: req.kind, requestId: req.requestId });
      continue;
    }

    log("request", { kind: req.kind, requestId: req.requestId, path: req.path });
    try {
      await client.reply(req.requestId, "working");
      let snapshot: Snapshot | undefined;
      if (prefetch) {
        try {
          snapshot = await client.snapshot(req.path);
        } catch {
          snapshot = undefined;
        }
      }
      const ops = await handler(req, { client, snapshot });
      if (ops && ops.length > 0) {
        await client.applyTier2Ops(req, ops);
      }
      await client.reply(req.requestId, "done");
      log("done", { requestId: req.requestId });
    } catch (e) {
      if (e instanceof StaleRequestError) {
        // Fail closed: the human moved on. Do not re-interpret against new content.
        await client.reply(req.requestId, "stale").catch(() => {});
        log("stale", { requestId: req.requestId });
      } else {
        await client.reply(req.requestId, "error").catch(() => {});
        log("error", { requestId: req.requestId, error: (e as Error).message });
      }
    }
  }
  log("stopped");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encodeFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
