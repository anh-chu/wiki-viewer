/**
 * Typed HTTP client over the wiki-viewer agent filesystem API.
 * Contract: docs/agent-fs-plan.md §2.
 *
 * All methods throw WikiViewerError on non-2xx unless noted.
 * The caller (index.ts) catches 409/412 and surfaces them cleanly to the agent.
 */

import * as cache from "./state-cache.js";
import type { CollabState, PathState } from "./state-cache.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface ClientConfig {
  baseUrl: string;       // e.g. "https://notes.example.com"
  token: string;         // Bearer token from TOFU registration
  agentId: string;       // X-Agent-Id header
  /** Target workspace id (X-Workspace header). Optional: omit for single-workspace instances. */
  workspace?: string;
  /** Override fetch implementation (for testing) */
  fetch?: typeof fetch;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class WikiViewerError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "WikiViewerError";
  }
}

export class IfMatchError extends WikiViewerError {
  constructor(path: string, body?: unknown) {
    super(412, "IF_MATCH_MISMATCH", `If-Match mismatch for ${path} — re-read before writing`, body);
    this.name = "IfMatchError";
  }
}

export class CollabActiveError extends WikiViewerError {
  constructor(
    path: string,
    public readonly snapshotUrl: string | null,
    body?: unknown,
  ) {
    super(409, "COLLAB_ACTIVE", `${path} is being actively collaborated on — use Tier-2 block-ops`, body);
    this.name = "CollabActiveError";
  }
}

/** PATCH endpoint absent (old server) or method not allowed — caller should fall back to read+PUT. */
export class PatchUnsupportedError extends WikiViewerError {
  constructor(path: string, status: number) {
    super(status, "PATCH_UNSUPPORTED", `Server does not support PATCH for ${path}`, undefined);
    this.name = "PatchUnsupportedError";
  }
}

/** Server-side str-replace found a different number of matches than expected. */
export class MatchCountError extends WikiViewerError {
  constructor(path: string, public readonly found: number, public readonly expected: number, body?: unknown) {
    super(422, "MATCH_COUNT_MISMATCH", `${path}: expected ${expected} match(es), found ${found}`, body);
    this.name = "MatchCountError";
  }
}

// ─── Response shapes ─────────────────────────────────────────────────────────

export interface ReadResult {
  /** Raw response bytes */
  body: Uint8Array;
  /** UTF-8 text, if the content-type is text */
  text: string | null;
  sha256: string;
  size: number;
  mtime: string;
  contentType: string;
  collabState: CollabState;
  collabRevision: number | null;
  collabSnapshot: string | null;
}

export interface WriteResult {
  path: string;
  sha256: string;
  size: number;
  mtime: string;
  created: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  mtime: string | null;
}

export interface SearchMatch {
  path: string;
  line?: number;
  text?: string;
}

export interface SearchResult {
  kind: "grep" | "glob";
  matches: SearchMatch[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class WikiViewerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly agentId: string;
  private readonly workspace?: string;
  private readonly _fetch: typeof fetch;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
    this.agentId = config.agentId;
    this.workspace = config.workspace;
    this._fetch = config.fetch ?? globalThis.fetch;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "X-Agent-Id": this.agentId,
      // Target a specific workspace when configured. Omitted = server default.
      ...(this.workspace ? { "X-Workspace": this.workspace } : {}),
      ...extra,
    };
  }

  private url(path: string, params?: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        u.searchParams.set(k, v);
      }
    }
    return u.toString();
  }

  private async assertOk(res: Response, path: string): Promise<void> {
    if (res.ok) return;
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text().catch(() => undefined); }
    if (res.status === 412) throw new IfMatchError(path, body);
    if (res.status === 409) {
      const snapshotUrl = (body as Record<string, unknown>)?.snapshotUrl as string | null ?? null;
      throw new CollabActiveError(path, snapshotUrl, body);
    }
    throw new WikiViewerError(
      res.status,
      `HTTP_${res.status}`,
      `wiki-viewer ${res.status} for ${path}: ${res.statusText}`,
      body,
    );
  }

  private parseCollabHeaders(res: Response): Pick<ReadResult, "collabState" | "collabRevision" | "collabSnapshot"> {
    const raw = (res.headers.get("X-Collab-State") ?? "not-markdown") as CollabState;
    const validStates: CollabState[] = ["active", "tracked", "untracked", "not-markdown"];
    const collabState: CollabState = validStates.includes(raw) ? raw : "not-markdown";
    const revRaw = res.headers.get("X-Collab-Revision");
    const collabRevision = revRaw !== null ? parseInt(revRaw, 10) : null;
    const collabSnapshot = res.headers.get("X-Collab-Snapshot") ?? null;
    return { collabState, collabRevision, collabSnapshot };
  }

  // ── read_file ──────────────────────────────────────────────────────────────

  async readFile(path: string, range?: string): Promise<ReadResult> {
    const extraHeaders: Record<string, string> = {};
    if (range) extraHeaders["Range"] = range;

    const res = await this._fetch(
      this.url(`/api/agent/fs/file/${encodeFilePath(path)}`),
      { headers: this.headers(extraHeaders) },
    );
    await this.assertOk(res, path);

    const sha256 = stripQuotes(res.headers.get("ETag") ?? "");
    const size = parseInt(res.headers.get("X-File-Size") ?? "0", 10);
    const mtime = res.headers.get("X-File-Mtime") ?? "";
    const contentType = res.headers.get("Content-Type") ?? "application/octet-stream";
    const collab = this.parseCollabHeaders(res);

    const bodyBuf = new Uint8Array(await res.arrayBuffer());
    const isText = contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("typescript");

    const text = isText ? new TextDecoder().decode(bodyBuf) : null;

    const state: PathState = {
      sha256,
      collabState: collab.collabState,
      collabRevision: collab.collabRevision,
      collabSnapshot: collab.collabSnapshot,
      fetchedAt: Date.now(),
      // Cache the text body (bounded) so edit_file can skip a re-GET.
      body: text !== null && bodyBuf.byteLength <= cache.MAX_CACHED_BODY_BYTES ? text : undefined,
    };
    cache.set(path, state);

    return { body: bodyBuf, text, sha256, size, mtime, contentType, ...collab };
  }

  // ── write_file ─────────────────────────────────────────────────────────────

  async writeFile(
    path: string,
    content: string | Uint8Array,
    opts: {
      ifMatch?: string;
      mkdirs?: boolean;
      force?: boolean;
      /** If-Collab-Match: X-Collab-Revision value (when knowingly writing to a tracked .md) */
      ifCollabMatch?: number;
    } = {},
  ): Promise<WriteResult> {
    const extraHeaders: Record<string, string> = {};
    // Auto-fill If-Match from the last-read sha (cache) on overwrite, unless the
    // caller explicitly supplied one or is forcing. A create (no cached sha) omits it.
    const ifMatch = opts.ifMatch ?? (opts.force ? undefined : cache.get(path)?.sha256);
    if (ifMatch) extraHeaders["If-Match"] = ifMatch;
    if (opts.ifCollabMatch !== undefined) {
      extraHeaders["If-Collab-Match"] = String(opts.ifCollabMatch);
    }

    const params: Record<string, string> = {};
    if (opts.mkdirs) params["mkdirs"] = "true";
    if (opts.force) params["force"] = "true";

    const encoded: Uint8Array = typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
    const body = encoded as unknown as Uint8Array<ArrayBuffer>;

    const doPut = (headers: Record<string, string>) =>
      this._fetch(this.url(`/api/agent/fs/file/${encodeFilePath(path)}`, params), {
        method: "PUT",
        headers: this.headers({ "Content-Type": "application/octet-stream", ...headers }),
        body,
      });

    let res = await doPut(extraHeaders);

    // Auto-recover from "If-Match required" (overwrite without a known sha):
    // the server demands a precondition for existing files. Transparently fetch
    // the current sha and retry once, instead of bubbling a 412 to the agent
    // (which would cost it an extra read + retry round-trip of its own).
    if (
      res.status === 412 &&
      !extraHeaders["If-Match"] &&
      !opts.force &&
      opts.ifMatch === undefined
    ) {
      let body412: unknown;
      try { body412 = await res.clone().json(); } catch { /* ignore */ }
      const code = (body412 as Record<string, unknown> | undefined)?.error;
      if (code === "PRECONDITION_REQUIRED") {
        const cur = await this.readFile(path);
        if (cur?.sha256) {
          res = await doPut({ ...extraHeaders, "If-Match": cur.sha256 });
        }
      }
    }

    await this.assertOk(res, path);

    const result: WriteResult = await res.json() as WriteResult;
    // Update cache after a successful write. Preserve known collab fields from a
    // prior read (do NOT clobber to not-markdown), refresh sha + body.
    const prior = cache.get(path);
    const text = typeof content === "string" ? content : null;
    cache.set(path, {
      sha256: result.sha256,
      collabState: prior?.collabState ?? "not-markdown",
      collabRevision: prior?.collabRevision ?? null,
      collabSnapshot: prior?.collabSnapshot ?? null,
      fetchedAt: Date.now(),
      body: text !== null && encoded.byteLength <= cache.MAX_CACHED_BODY_BYTES ? text : undefined,
    });
    return result;
  }

  // ── patch_file (server-side str-replace) ─────────────────────────────────────

  /**
   * Server-side exact str-replace: sends only {find, replace} instead of the
   * whole file. Requires If-Match (auto-filled from cache if not given).
   * Throws PatchUnsupportedError on 404/405 so callers can fall back to
   * read+PUT against older servers, and MatchCountError on 422.
   */
  async patchFile(
    path: string,
    find: string,
    replace: string,
    opts: { ifMatch?: string; expectedOccurrences?: number; ifCollabMatch?: number } = {},
  ): Promise<WriteResult> {
    const ifMatch = opts.ifMatch ?? cache.get(path)?.sha256;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ifMatch) headers["If-Match"] = ifMatch;
    if (opts.ifCollabMatch !== undefined) headers["If-Collab-Match"] = String(opts.ifCollabMatch);

    const payload: Record<string, unknown> = { find, replace };
    if (opts.expectedOccurrences !== undefined) payload.expectedOccurrences = opts.expectedOccurrences;

    const res = await this._fetch(
      this.url(`/api/agent/fs/file/${encodeFilePath(path)}`),
      { method: "PATCH", headers: this.headers(headers), body: JSON.stringify(payload) },
    );

    // 405 = method not allowed (endpoint absent). 404 is ambiguous: our handler
    // returns 404 {error:"NOT_FOUND"} for a missing FILE, but an old server with
    // no PATCH route returns a bare 404. Only treat 404 as "unsupported" when the
    // body is NOT our structured NOT_FOUND (so a missing file surfaces normally).
    if (res.status === 405) {
      throw new PatchUnsupportedError(path, res.status);
    }
    if (res.status === 404) {
      let body: unknown;
      try { body = await res.clone().json(); } catch { /* not JSON → likely no route */ }
      const code = (body as Record<string, unknown> | undefined)?.error;
      if (code !== "NOT_FOUND") throw new PatchUnsupportedError(path, 404);
      // else fall through to assertOk → throws WikiViewerError(404) for missing file
    }
    if (res.status === 422) {
      let body: unknown;
      try { body = await res.json(); } catch { /* ignore */ }
      const b = body as Record<string, unknown> | undefined;
      throw new MatchCountError(path, Number(b?.found ?? -1), Number(b?.expected ?? -1), body);
    }
    await this.assertOk(res, path);

    const result: WriteResult = await res.json() as WriteResult;
    const prior = cache.get(path);
    cache.set(path, {
      sha256: result.sha256,
      collabState: prior?.collabState ?? "not-markdown",
      collabRevision: prior?.collabRevision ?? null,
      collabSnapshot: prior?.collabSnapshot ?? null,
      fetchedAt: Date.now(),
      // We don't have the full new body here without reconstructing it; drop the
      // stale cached body so the next edit re-reads rather than patching blind.
      body: undefined,
    });
    return result;
  }

  // ── delete_file ────────────────────────────────────────────────────────────

  async deleteFile(
    path: string,
    ifMatch: string,
    opts: { recursive?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const params: Record<string, string> = {};
    if (opts.recursive) params["recursive"] = "true";
    if (opts.force) params["force"] = "true";

    const res = await this._fetch(
      this.url(`/api/agent/fs/file/${encodeFilePath(path)}`, params),
      {
        method: "DELETE",
        headers: this.headers({ "If-Match": ifMatch }),
      },
    );
    await this.assertOk(res, path);
    cache.del(path);
  }

  // ── list_directory ─────────────────────────────────────────────────────────

  async listDirectory(
    path: string,
    opts: { recursive?: boolean; depth?: number; limit?: number } = {},
  ): Promise<DirEntry[]> {
    const params: Record<string, string> = {};
    if (opts.recursive) params["recursive"] = "true";
    if (opts.depth !== undefined) params["depth"] = String(opts.depth);
    if (opts.limit !== undefined) params["limit"] = String(opts.limit);

    const res = await this._fetch(
      this.url(`/api/agent/fs/ls/${encodeFilePath(path)}`, params),
      { headers: this.headers() },
    );
    await this.assertOk(res, path);
    return res.json() as Promise<DirEntry[]>;
  }

  // ── search ────────────────────────────────────────────────────────────────

  async search(body: {
    kind: "grep" | "glob";
    query: string;
    path?: string;
    glob?: string;
    limit?: number;
  }): Promise<SearchResult> {
    const res = await this._fetch(
      this.url("/api/agent/fs/search"),
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    await this.assertOk(res, "search");
    return res.json() as Promise<SearchResult>;
  }

  // ── move_file ─────────────────────────────────────────────────────────────

  async moveFile(from: string, to: string, ifMatch?: string): Promise<void> {
    const body: Record<string, string> = { from, to };
    if (ifMatch) body["ifMatch"] = ifMatch;

    const res = await this._fetch(
      this.url("/api/agent/fs/move"),
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    await this.assertOk(res, from);
    cache.rename(from, to);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Encode path segments but preserve slashes */
function encodeFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function stripQuotes(etag: string): string {
  return etag.replace(/^"/, "").replace(/"$/, "");
}
