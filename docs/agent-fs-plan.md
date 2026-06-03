# Agent Filesystem Plan — "Two tiers, one spine"

**Status:** Proposed (co-designed; ready for sign-off).
**Goal:** Let a remote AI agent work with files in a wiki-viewer instance "barely worse than local filesystem", for **all file types**, without disturbing the existing markdown collaboration feature.
**Principle:** Elegant, minimalistic, boring on purpose. The bytes API is strict and observable; the collab tier stays special. No CRDT pivot. No exec. No PATCH. No JSON-RPC.

> Supersedes the unbuilt `docs/agent-collab-v2-plan.md` Yjs/Hocuspocus/Postgres direction, which is treated as discarded. App today = `better-auth` + `better-sqlite3`, file-on-disk-is-truth.

---

## 1. The model: two provenance tiers, one shared spine

```
                 ┌────────────────────────────────────────────┐
                 │              SHARED SPINE                  │
                 │  discovery (/api/agents/install)           │
                 │  TOFU register → approve → one-shot token  │
                 │  Authorization: Bearer + X-Agent-Id        │
                 │  enforceScope(path-glob, op)               │
                 │  withFileMutex (in-proc + proper-lockfile) │
                 │  safeRootPath (traversal/symlink guard)    │
                 │  event log + audit                         │
                 └───────────────┬───────────────┬────────────┘
                                 │               │
              ┌──────────────────▼──┐      ┌─────▼───────────────────────┐
              │  TIER 1 — RAW FS    │      │  TIER 2 — COLLAB (existing) │
              │  all file types     │      │  markdown only              │
              │  read/write/ls/     │      │  block-ops + proof-spans    │
              │  move/delete/search │      │  comments / suggestions     │
              │  boring bytes       │      │  reviewable prose, accept/  │
              │  light audit        │      │  revert provenance          │
              └─────────────────────┘      └─────────────────────────────┘
```

- **Tier 1 (Raw FS, NEW):** bytes on disk, every file type, fast agent tooling. Light audit (event + sha). The "do filework" tier.
- **Tier 2 (Collab, EXISTING, UNCHANGED):** markdown review layer — block-ops, `<proof-span>` marks, comments, suggestions. The "reviewable prose" tier.
- **Do NOT** fold block-ops into the fs endpoint as a content-type. Collab is a review/provenance _workflow_, not file IO. Different invariants. Keep them separate; share the spine only.

---

## 2. Tier 1 — Raw FS API (v1, minimal)

All routes reuse `checkAuth` + `enforceScope` + `withFileMutex` + `safeRootPath`. All reject paths under `.proof/`, the lock dir, and the app db/config. Scope is enforced on **every** surface (reads, listings, search results, move endpoints).

| Method   | Route                                           | Purpose                                                                      |
| -------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/agent/fs/file/<path>`                     | Read file. Supports `Range`. Returns raw bytes.                              |
| `PUT`    | `/api/agent/fs/file/<path>`                     | Atomic whole-file write. `If-Match: <sha256>` optional (REQUIRED for `.md`). |
| `DELETE` | `/api/agent/fs/file/<path>`                     | Delete file (+ sidecar if `.md`).                                            |
| `GET`    | `/api/agent/fs/ls/<path>?recursive&limit&depth` | Directory listing. Scope-filtered.                                           |
| `POST`   | `/api/agent/fs/move`                            | `{from, to, ifMatch?}`. Moves sidecar for `.md`.                             |
| `POST`   | `/api/agent/fs/search`                          | `{kind:"grep"\|"glob", query, path?, glob?, limit?}`. Server-side.           |

**No exec. No batch. No separate grep/glob.** Add later only if profiling proves need.

> **Update (shipped):** A server-side `PATCH /api/agent/fs/file/<path>` str-replace endpoint was added after profiling proved the whole-file-PUT payload dominates latency for large docs on slow uplinks (500KB @ 0.5Mbps ≈ 7.8s/edit transfer). It is strict: exact substring (no regex), text/UTF-8 only, `If-Match` required, `expectedOccurrences` must match exactly (default 1, else 422 `MATCH_COUNT_MISMATCH`). It shares one mutation code path (`applyMutation`) with PUT, so lock / R6 `COLLAB_ACTIVE` / reconcile / audit behave identically. The MCP `edit_file` tool uses PATCH first and falls back to read+PUT on older servers.

### 2.1 Read (`GET .../file/<path>`)

- Returns **raw bytes**, not a JSON wrapper.
- Metadata in headers: `ETag: "<sha256>"`, `X-File-Size`, `X-File-Mtime`, `Content-Type`.
- Supports HTTP `Range` for big/binary files.

### 2.2 Write (`PUT .../file/<path>`)

- Atomic: write temp in **same dir** → `fsync` → `rename`. (`fsync` dir optional but documented.)
- Preserve mode of existing file. Do **not** create parent dirs unless `?mkdirs=true`.
- **Create = implicit.** `PUT` to a non-existent path creates the file (write-with-no-prior). Omit `If-Match` for a create; send `If-Match: <sha256>` only when overwriting. A create where the file already exists (no `If-Match`) → 412, so creates can't silently clobber.
- `If-Match: <sha256>` → 412 on mismatch. **Required by default for overwrites** (see R4); explicit `?force=true` bypasses and is audited.
- Response: `{path, sha256, size, mtime, created: bool}`.

### 2.3 Listing (`GET .../ls`)

- Hard limits: `max entries`, `max depth`, cursor or hard cap. Excludes `.proof/`; ignores `.git/` (configurable).
- Each entry: `{name, type, size, mtime}`. Unauthorized paths omitted (scope-filtered).

### 2.4 Search (`POST .../search`)

- `kind: "grep" | "glob"`. No shell interpolation (spawn ripgrep with arg array, or in-process).
- Limits: timeout, max matches, max bytes scanned, skip binary. Each matched path re-checked against scope.
- This is the **round-trip-explosion mitigation** — one call replaces dozens of `ls`+`read`.

### 2.5 Move (`POST .../move`)

- Checks: source `read`+`mutate`, dest `mutate`.
- For `.md`: moves the `.proof/<path>.json` sidecar too. Lock ordering: single operation lock, or lock source+dest in **sorted key order** to avoid deadlock.

### 2.6 Delete (`DELETE .../file/<path>`)

- Requires the `delete` scope op (see §3.5) and `If-Match: <sha256>` — the agent must have read the current file first, so it cannot blind-delete. This `If-Match` requirement **is** the confirmation for v1.
- `.md`: also deletes the sidecar (R3).
- Directory delete is opt-in and explicit: `?recursive=true`; without it, deleting a non-empty dir is refused. (No human approval queue in v1 — deferred.)

---

## 3. Tier 2 — Collab (unchanged)

Markdown block-ops (`block.replace/insertAfter/insertBefore/delete/append/prepend`), `comment.*`, `suggestion.*`, `<proof-span>` marks, `baseRevision` optimistic concurrency, mandatory `Idempotency-Key`, sidecar JSON in `.proof/`. **No changes.** This remains the reviewable-prose path.

---

## 3.5 Working mode vs Collaborating mode (THE central distinction)

The whole design hinges on the agent knowing **when a file is being actively co-edited by a human** (use the reviewable Tier-2 path) versus **when it's just a file to work on** (use fast raw Tier-1). Today nothing tells the agent this; a wrong guess clobbers a human's pending suggestions. We make the mode **discoverable, documented, and enforced** — three layers so the agent cannot miss it.

### The signal: `X-Collab-State` header (on every read, both tiers)

Every `GET fs/file/<path>` and every Tier-2 snapshot read returns:

```
X-Collab-State: active | tracked | untracked | not-markdown
X-Collab-Snapshot: /api/agent/files/<path>.md      # present when state != not-markdown
```

| State          | Meaning                                                                                                                                                                                                                                      | Agent should…                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`       | `.md` that is **live**: either has review artifacts (pending suggestions / unresolved comments / unreverted proof-spans) **OR has a current human edit lease** (someone has the doc open in the editor). A human is collaborating right now. | **Use Tier-2 block-ops.** Your edits become reviewable suggestions. A raw `PUT` is rejected unless `If-Collab-Match` matches (see R6).                    |
| `tracked`      | `.md` with a sidecar, no artifacts, no lease.                                                                                                                                                                                                | **Prefer Tier-2 for any semantic/prose edit** so provenance accrues. Raw only for mechanical/whole-file ops (e.g. reformat, regenerate). Not a free pass. |
| `untracked`    | `.md`, no sidecar, no lease — nobody has collaborated.                                                                                                                                                                                       | Raw ok. A reviewable (Tier-2) edit creates a sidecar so future edits are tracked.                                                                         |
| `not-markdown` | Any non-`.md` file.                                                                                                                                                                                                                          | **Tier-1 raw only** (Tier-2 doesn't apply).                                                                                                               |

**Definition of `active` (two sources, OR'd):**

1. **Artifacts:** `pendingSuggestions > 0` OR `unresolvedComments > 0` OR `proofSpanCount > 0` (from sidecar — cheap, already in memory on read).
2. **Human edit lease:** a short-TTL presence marker (default 90s, heartbeat ~30s) set when a human opens the doc in the editor and refreshed while it stays open. **This closes the false-negative GPT-5.5 caught:** a human who opens a doc but hasn't typed a suggestion yet still reads `active`, so the agent won't blind-write into a live session. Lease lives in-memory (or the existing SQLite), keyed by `(path)`, set by a lightweight `POST /api/wiki/presence` ping the editor already can issue alongside its chokidar SSE connection. No lease + no artifacts → not active.

### Layer 2 — documented (manifest + skill)

The `/api/agents/install` manifest and the skill state the rule in one sentence:

> _"Before editing a `.md`, read it and check `X-Collab-State`. If `active`, use block-ops (Tier 2) so a human can review. Otherwise use raw fs (Tier 1). For non-markdown, always use raw fs."_

### Layer 3 — enforced (R4 + R6 backstop)

Even a confused or racing agent cannot silently clobber a live session: a raw `PUT` to an `active` `.md` is **rejected with 409 `COLLAB_ACTIVE`** unless it carries a matching `If-Collab-Match` (R6) — and the state is re-checked atomically inside the write mutex, so a session that goes active mid-flight still wins. Any genuinely orphaned suggestion/comment is marked `stale` by reconciliation (R2), never dropped. The 409 returns the Tier-2 snapshot URL, re-teaching the mode.

### What the human sees

- Agent works in Tier-2 on an `active` doc → normal reviewable suggestions (existing UX).
- Agent raw-writes an `active` doc anyway → `file.rawWritten by ai:<id>` in the AI Panel feed + any unbindable anchors flagged `stale` (not vanished).
- Agent works on `untracked`/non-md → silent, fast, audited. No collab noise.

---

## 4. Integration rules (load-bearing)

- **R1 — Shared lock.** A raw write/move/delete on a `.md` acquires the **same** `withFileMutex` key the ops-applier uses. No interleaving with block-ops mid-proof-span.
- **R2 — No fake provenance.** Raw writes never author proof-spans. After a raw write to a tracked `.md`, emit `file.rawWritten` (writer known) and **reconcile the sidecar synchronously, inside the same mutex** (rebuild `refMap`, set fingerprint to `newSha`, mark affected proof refs stale). Raw edits are unmarked by definition; human sees _who_ via the event, not as an accept/revert suggestion.
  - **GOTCHA (do not regress):** do NOT just "bump fingerprint to newSha and let existing reconciliation fire later." The existing reconciliation triggers on `sidecar.fingerprint != file sha256`; if the raw write sets fingerprint current, the mismatch is gone and rebuild never runs. Because the writer is known, reconcile **eagerly within the write**, not lazily on next read.
- **R3 — Sidecar lifecycle.** Raw `mv`/`rm` of a `.md` moves/deletes its sidecar. **NOTE:** the human `wiki/move` route currently does a bare `rename` and does NOT move the sidecar — a latent bug that orphans `.proof/` JSON today. Build a shared `moveSidecar`/`deleteSidecar` helper in `sidecar.ts` and wire **both** the raw-fs path and `wiki/move` to it (fixes the existing bug for free).
- **R4 — Write guard (If-Match by default).** **All** mutating raw ops (`PUT`/`DELETE`/`move`) REQUIRE `If-Match: <sha256>` by default; 412 on mismatch. An explicit `?force=true` bypasses it and is recorded in the audit row. Rationale: agents edit code/config just as much as `.md`; optional concurrency = silent lost updates, and a format-based safety boundary is arbitrary. Cheap because the agent already has the sha from `GET`.
- **R5 — Scope unification + `delete` op.** Registration `scope.paths` glob already covers **directories natively** (e.g. `notes/**` grants the whole subtree — no file lists). Raw-fs honors the same glob, on every surface (read/ls/search/move/delete results all re-checked). **One addition:** split `delete` out of `mutate`, so `scope.ops` becomes `[read, mutate, delete]`. This lets a human grant "edit but never delete." `mutate` = create/overwrite/move; `delete` = remove. Back-compat: existing `[read, mutate]` agents simply can't delete until re-scoped. Glob dialect (v1): `**`, `*`, `?` only — no braces/negation; advertise this in the manifest.
- **R6 — Collab-state precondition on raw `.md` writes (closes the TOCTOU race).** `If-Match` protects _bytes_, not _collaboration intent_: a human could create a sidecar/lease after the agent's read but before its raw `PUT`, leaving bytes unchanged so `If-Match` still passes. To prevent silently writing into a session that went `active` mid-flight:
  - Every `.md` read also returns `X-Collab-Revision: <n>` (bumped on any sidecar/lease state change).
  - A raw `PUT` to a `.md` must, **inside the same mutex, re-read collab state immediately before writing**: if the doc is now `active` and the request did not supply a matching `If-Collab-Match: <n>`, **reject with 409 `COLLAB_ACTIVE`** + the Tier-2 snapshot URL. The agent then switches to block-ops. `?force=true` still bypasses (audited) for deliberate overrides.
  - This makes the mode check atomic with the write, not advisory.

### Event taxonomy (don't overload)

- `file.rawWritten` — writer **known** (`by: ai:<id>`, `oldSha`, `newSha`, `path`, `at`). Emitted by raw-fs mutations.
- `file.externallyEdited` — writer **unknown** (chokidar watcher, vim, git). Existing behavior, untouched.

### Audit

- `.md`: append event to sidecar (already have the machinery).
- All other files: durable audit row (reuse SQLite). Non-negotiable — without it an agent could silently rewrite a PDF.

### Collab-anchor safety (raw `.md` overwrite)

A full-file `PUT` to a `.md` can strip `<proof-span>` marks and shift block boundaries, orphaning pending comments/suggestions. **Invariant:** after any raw write to a `.md`, the synchronous reconciliation (R2) MUST re-bind or mark-stale every affected proof ref **before** the human UI reads the snapshot. A suggestion/comment whose anchor no longer resolves is flagged `stale`, not silently dropped. This is the explicit guard that keeps Tier 1 from corrupting Tier 2.

---

## 5. Discovery

Extend `/api/agents/install` manifest:

- Advertise the new `fs/*` routes.
- Add a `capabilities` block: `{ maxFileBytes, supportsRange, ifMatchRequired:true, forceBypass:true, search:["grep","glob"], globDialect:"**,*,?", scopeOps:["read","mutate","delete"], collabStates:["active","tracked","untracked","not-markdown"], collabPrecondition:"If-Collab-Match" }`.
- State the **working-vs-collaborating rule** (§3.5) in prose so the agent self-configures its tier choice.
- Advertise the optional MCP adapter package + version.
  One manifest; agent self-configures. HTTP routes are the canonical contract.

---

## 6. Client story

- **Canonical = the HTTP API.** Easy to curl, test, version. Independent of MCP transport churn.
- **`npx wiki-viewer-mcp`** = thin MCP adapter mapping standard MCP filesystem tools onto these endpoints:
  - `read_file` → `GET fs/file`
  - `write_file` → `PUT fs/file` (with `If-Match` from a prior read)
  - `edit_file` (str-replace) → **client-side**: read → transform → `PUT If-Match`. (Server stays dumb; edit footguns live in the adapter.)
  - `list_directory` → `GET fs/ls`
  - `search` → `POST fs/search`
  - `delete_file` → `DELETE fs/file` (requires `delete` scope + `If-Match`)
- The shim reads `X-Collab-State` and, when `active`, **warns or routes the edit through the Tier-2 block-op tools** instead of a blind raw write — so even off-the-shelf MCP clients respect collaborating mode.
- Do **not** make the core app MCP-native first. The app already has HTTP auth/discovery; the shim adapts to Claude Code / Cursor / Codex without poisoning the core.

---

## 7. Path identity (must specify before build)

- Stable **relative** paths only; reject traversal and symlinks escaping root.
- Decide + document symlink listing behavior.
- Hard-deny: `.proof/`, `~/.wiki-viewer/.locks/`, the app SQLite db + config.
- Unicode normalization policy stated explicitly.

---

## 8. Non-goals (explicit)

- **No remote compute / exec.** wiki-viewer is a remote **filesystem + review surface**, not a sandbox. Real exec needs quotas, secrets/env/cwd policy, process lifecycle, cancellation, logs — a different product. Server-side `search` covers the ~80% case (find code) without it. Future: a separate optional "workspace daemon" with its own scope + manifest capability.
- **No CRDT / Yjs / Hocuspocus.** File-on-disk stays truth.
- **No PATCH, no JSON-RPC, no batch endpoint** in v1.

---

## 9. Build order

1. Spine confirm: nothing new — reuse auth/scope/lock/safePath.
2. `GET/PUT/DELETE fs/file` + atomic write + `If-Match` + headers/ETag/Range.
3. Audit row + `file.rawWritten` event; wire R1/R2 for `.md`.
4. `fs/ls` (limits, scope filter) + `fs/move` (sidecar move, R3).
5. `fs/search` (grep/glob, limits).
6. Extend `/api/agents/install` manifest + capabilities.
7. `wiki-viewer-mcp` adapter (read/write/edit/list/search).
8. **Mode plumbing:** human edit-lease (`POST /api/wiki/presence` + TTL, editor heartbeat), `X-Collab-State` + `X-Collab-Revision` headers on both read paths, R6 atomic re-check + 409 `COLLAB_ACTIVE` on raw `.md` writes. Plus `delete` scope op + create/`?mkdirs`/`?recursive` semantics.
9. Tests: traversal, symlink escape, If-Match 412, create-collision 412, sidecar move (incl. `wiki/move` bug fix), scope filtering on ls/search, big-file Range, binary skip in grep, **`X-Collab-State` matrix incl. lease-only `active`**, **R6 TOCTOU: doc goes active between read and raw PUT → 409**, stale-anchor after raw `.md` overwrite, `delete` op gating, lease expiry flips active→tracked.

```

```
