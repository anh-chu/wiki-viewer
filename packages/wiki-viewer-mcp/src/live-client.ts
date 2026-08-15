/**
 * Agent-side runtime for wiki-viewer live collaboration.
 *
 * Contract: agents/wiki-viewer-skill/SKILL.md "Live collaboration" section.
 *
 * The live channel is a control plane only: it carries a human's block-scoped
 * instruction to an attached agent that holds a long-poll. The actual document
 * edit still flows through the ordinary Tier-2 path
 * (POST /api/agent/files/<path>.md) with the request's own baseRevision,
 * Idempotency-Key = live:<requestId>. Correlation is recorded in activity only.
 *
 * This module never writes files itself except through applyTier2Ops, which is
 * the canonical commit path.
 */

import { createHash } from "node:crypto";

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
  kind: "generate" | "steer" | "accept" | "discard" | "exit" | "web.tweak" | "web.tweak.variants";
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
  /** @deprecated Accepted but ignored by the server; retained for wire compatibility. */
  inResponseTo: string;
}

export type PollResponse =
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
  /** @deprecated Accepted but ignored by the server; retained for wire compatibility. */
  basis?: "described" | "inferred" | "suggested";
  /** @deprecated Accepted but ignored by the server; retained for wire compatibility. */
  basisDetail?: string;
  /** @deprecated Accepted but ignored by the server; retained for wire compatibility. */
  inResponseTo?: string;
}

export interface SnapshotBlock {
  ref: string;
  type: string;
  markdown: string;
}

// ─── Web-tweak wire shapes (copied locally; mcp is standalone) ──────────────────
// These mirror src/lib/web-tweak/protocol.ts + preview-store.ts. They are copied
// intentionally: the published mcp package must not import from the app's src/lib.

/** Data-only DOM preview operation. No HTML/script injection is representable. */
export type DomOp =
  | { type: "setText"; value: string }
  | { type: "setStyle"; prop: string; value: string }
  | { type: "setAttr"; name: string; value: string }
  | { type: "removeAttr"; name: string }
  | { type: "addClass"; value: string }
  | { type: "removeClass"; value: string };

/** One file the candidate patch was derived against, pinned by content hash. */
export interface BaseFile {
  path: string;
  sha256: string;
}

/**
 * The immutable source edit accept will commit: whole-file replacements. `null`
 * candidate means "visual only, not acceptable".
 */
export interface CandidateSourcePatch {
  files: Array<{ path: string; content: string }>;
  summary: string;
}

/** Per-instruction DOM preview ops for a batch run. */
export interface WebItemPreview {
  instructionId: string;
  ops: DomOp[];
}

/** One candidate option in a web.tweak.variants reply. */
export interface WebVariant {
  variantId: string;
  label: string;
  domPreviewOps: DomOp[] | null;
  candidateSourcePatch: CandidateSourcePatch | null;
  baseFiles: BaseFile[];
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
  private attachedWorkspaceId?: string;

  get workspaceId(): string | undefined {
    return this.attachedWorkspaceId ?? this.workspace;
  }

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
    const msg = typeof (body as any)?.message === "string" ? (body as any).message : "";
    throw new LiveError(res.status, code, `live ${res.status}: ${code}${msg ? ` — ${msg}` : ""}`, body);
  }

  /** Attach (idempotent per agent+workspace). Returns the session id. */
  async attach(): Promise<string> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/live/attach`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: "{}",
    });
    if (!res.ok) await this.parseError(res);
    const body = (await res.json()) as { sessionId: string; workspaceId?: string };
    this.attachedWorkspaceId = body.workspaceId;
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
    // Preserve idempotency from request id. Correlation recorded in activity feed
    // only, not document bytes; legacy provenance fields are accepted and ignored.
    const correlation = `live:${req.requestId}`;
    const cleanOps = ops.map(({ basis: _basis, basisDetail: _basisDetail, inResponseTo: _inResponseTo, ...op }) => op);
    const res = await this._fetch(`${this.baseUrl}/api/agent/files/${encodeFilePath(req.path)}`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "Idempotency-Key": correlation,
      }),
      body: JSON.stringify({
        baseRevision: req.baseRevision,
        by: this.agentId,
        ops: cleanOps,
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

  /**
   * Read a workspace file via the Tier-1 raw-fs path and return its content plus
   * the sha256 hex of that exact content. Used to pin baseFiles for a candidate
   * source patch (the hashes accept re-checks before committing).
   */
  async fetchFileForHash(path: string): Promise<{ content: string; sha256: string }> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/fs/file/${encodeFilePath(path)}`, {
      headers: this.headers(),
    });
    if (!res.ok) await this.parseError(res);
    const content = await res.text();
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    return { content, sha256 };
  }

  /** Submit markdown variants for human-only preview/accept. */
  async submitMarkdownPreview(input: {
    previewId: string;
    requestId: string;
    variants: Array<{ variantId?: string; label: string; markdown: string }>;
  }): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/api/agent/live/md-preview`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(input),
    });
    if (!res.ok) await this.parseError(res);
  }

  /**
   * Submit the agent's reply to a web.tweak request: DOM preview ops (applied
   * in-frame), the immutable candidate source patch, and the base file hashes it
   * was derived against. The candidate is stored, never applied here; the server
   * commits it later on human accept iff the base hashes still match.
   */
  async submitWebPreview(input: {
    previewId: string;
    requestId: string;
    domPreviewOps: DomOp[] | null;
    candidateSourcePatch: CandidateSourcePatch | null;
    baseFiles: BaseFile[];
    status: "done" | "error";
    itemPreviews?: WebItemPreview[] | null;
  }): Promise<void> {
    const u = new URL(`${this.baseUrl}/api/agent/live/web-preview`);
    if (this.workspace) u.searchParams.set("ws", this.workspace);
    const res = await this._fetch(u.toString(), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        previewId: input.previewId,
        requestId: input.requestId,
        domPreviewOps: input.domPreviewOps,
        candidateSourcePatch: input.candidateSourcePatch,
        baseFiles: input.baseFiles,
        status: input.status,
        itemPreviews: input.itemPreviews ?? null,
      }),
    });
    if (!res.ok) await this.parseError(res);
  }

  /**
   * Submit the agent's reply to a web.tweak.variants request: N candidate options
   * for one target, in a single request. Each variant carries its own DOM preview
   * ops, immutable candidate source patch, and base file hashes. The server
   * validates variant count/uniqueness and single-file scope; nothing is applied
   * here — the human picks one and the server commits it on accept.
   */
  async submitWebVariants(input: {
    previewId: string;
    requestId: string;
    variants: WebVariant[];
  }): Promise<void> {
    const u = new URL(`${this.baseUrl}/api/agent/live/web-preview`);
    if (this.workspace) u.searchParams.set("ws", this.workspace);
    const res = await this._fetch(u.toString(), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        previewId: input.previewId,
        requestId: input.requestId,
        status: "done",
        variants: input.variants,
      }),
    });
    if (!res.ok) await this.parseError(res);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function encodeFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

