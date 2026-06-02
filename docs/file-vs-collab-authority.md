# File vs Collab Authority Model

**TL;DR:** File on disk is truth. Tier-1 raw edits are fast + audited but unmarked. Tier-2 block-ops are slower but reviewable. The `X-Collab-State` header tells an agent which tier to use; the server enforces it atomically.

---

## Source of truth

The `.md` file on disk is the canonical document. The `.proof/<path>.json` sidecar holds provenance metadata (comments, suggestions, proof-span refs, fingerprint) but is never the source of truth for content. If the sidecar is lost the document is intact; if the document is lost the sidecar is orphaned.

---

## Two tiers

### Tier 1 — Raw FS

- Routes: `GET/PUT/DELETE /api/agent/fs/file/<path>`, `GET /api/agent/fs/ls/...`, `POST /api/agent/fs/move`, `POST /api/agent/fs/search`.
- All file types. Raw bytes in, raw bytes out.
- Writes are **atomic** (temp-file + rename in same directory).
- **Audit:** every mutation records a row in the `agent_fs_audit` SQLite table (`path`, `op`, `agentId`, `oldSha`, `newSha`, `forced`, `at`).
- **Event:** `file.rawWritten` emitted with `{ by: "ai:<id>", path, oldSha, newSha }`. Distinct from `file.externallyEdited` (chokidar, writer unknown).
- No `<proof-span>` marks. No accept/revert UI. Audit log is the paper trail.

### Tier 2 — Collab

- Routes: `GET/POST /api/agent/files/<path>.md`, `GET/POST /api/agent/events/<path>.md`.
- Markdown only.
- Edits are wrapped in `<proof-span>` marks inline in the `.md` file.
- Provenance (suggestions, comments, block refs) stored in `.proof/<path>.json` sidecar.
- Human can accept or revert individual spans in the editor UI.
- Mandatory `baseRevision` optimistic concurrency + `Idempotency-Key` per request.

---

## The `X-Collab-State` header

Every `GET /api/agent/fs/file/<path>` (Tier-1 read) and every Tier-2 snapshot read returns:

```
X-Collab-State: active | tracked | untracked | not-markdown
X-Collab-Revision: <n>
X-Collab-Snapshot: /api/agent/files/<path>.md   # present when not not-markdown
```

### State machine

```
[file created]
      │
      ▼
  untracked   ──── first Tier-2 op ────►  tracked
      │                                      │
      │  (Tier-1 writes stay untracked)      │  human opens editor
      │                                      ▼
      │                                   active
      │                                      │
      │                              editor closes +
      │                              no artifacts
      │                                      │
      │                                      ▼
      └──────────────────────────────────  tracked
```

**`active`** is set by two independent sources (OR'd):

1. **Artifacts** — sidecar has `pendingSuggestions > 0` OR `unresolvedComments > 0` OR `proofSpanCount > 0`. Cheap: always in memory when sidecar is loaded.
2. **Human edit lease** — a short-TTL presence marker (default 90 s, heartbeat ~30 s) set via `POST /api/wiki/presence { path, action: "open" | "heartbeat" | "close" }`. Closes the false-negative: a human who opens a doc but hasn't typed a suggestion yet still reads `active`.

`X-Collab-Revision` bumps on any sidecar write OR lease open/close. Used by R6.

---

## R6 — atomic TOCTOU race fix

`If-Match` (sha256) protects _bytes_. But a human could open the doc between the agent's read and its raw `PUT`, making it `active` while bytes are unchanged — so `If-Match` passes but the write clobbers a live session.

**Fix:** a raw `PUT` to any `.md` re-checks `collabState` **inside the same `withFileMutex` call, immediately before writing**. If the state is now `active` and the request did not supply a matching `If-Collab-Match: <revision>`, the write is **rejected 409 `COLLAB_ACTIVE`** with the Tier-2 URL. This check is atomic with the write — not advisory.

`?force=true` bypasses both `If-Match` and `If-Collab-Match` and is recorded in the audit row as `forced: true`.

---

## R2 — eager sidecar reconciliation

After a raw `PUT` to a tracked/active `.md`, the sidecar must be reconciled **synchronously, inside the same mutex**, before the lock is released:

1. Re-scan the new file bytes for surviving `<proof-span>` marks.
2. Re-bind each proof ref to its new block offset; mark unresolvable refs `stale: true`.
3. Set `sidecar.fingerprint = newSha` (so the lazy mismatch-trigger in `readSnapshot` does NOT re-fire — the reconcile already ran).
4. Emit `file.rawWritten` event.

**Do not** just bump the fingerprint and let reconciliation fire lazily on the next read. The lazy trigger fires only when `sidecar.fingerprint != file sha256`; once the raw write sets fingerprint current, the mismatch is gone and rebuild never runs. Eager reconciliation is the correct invariant.

---

## Known v1 limitations

### (a) Editor does not call `/api/wiki/presence` yet

The front-end editor does **not** currently issue `POST /api/wiki/presence` on open/heartbeat/close. Consequence: lease-based `active` never fires. Only artifact-based `active` works (pending suggestions, unresolved comments, proof-spans in sidecar).

**Impact:** a human who opens a doc but has no pending review artifacts will see `X-Collab-State: tracked` (or `untracked`), not `active`. An agent raw-writing that doc won't be blocked. This is a safety gap — not a correctness bug (no data loss), but the intended "lock out while human is live-editing" experience is incomplete until the editor heartbeat is wired.

**Fix:** call `POST /api/wiki/presence { path, action: "open" }` when the editor mounts the doc and `{ action: "close" }` on unmount. Heartbeat every ~30 s. Tracked as a follow-up task.

### (b) Lease store is in-memory (single-process only)

The presence lease map lives in the Node.js process memory. In a multi-process deployment (PM2 cluster mode, multiple Next.js instances behind a load balancer) each process has its own lease state and processes do not share it.

**Impact:** a human's open lease set by process A is invisible to process B. A raw write handled by process B may not see the `active` state and proceed when it should block.

**Fix:** move the lease store to the shared SQLite (`~/.wiki-viewer/auth.db`) with a TTL column and a periodic cleanup job. The table is already shared across the process boundary. Tracked as a follow-up task.

---

## Sidecar lifecycle rules

| Raw-fs op                | On non-`.md` | On `.md`                                                           |
| ------------------------ | ------------ | ------------------------------------------------------------------ |
| `PUT` (create/overwrite) | plain write  | acquire mutex → write → reconcile sidecar → emit `file.rawWritten` |
| `DELETE`                 | plain delete | delete file + delete `.proof/<path>.json` sidecar                  |
| `POST /fs/move`          | plain rename | rename file + rename `.proof/<old>.json` → `.proof/<new>.json`     |

The human `wiki/move` route was previously a bare `rename` that orphaned sidecars. It now uses the same shared `moveSidecar` helper (fixed in Phase 1).
