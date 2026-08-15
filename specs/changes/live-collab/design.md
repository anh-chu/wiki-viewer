# Design: Live agent collaboration

## Key realization from code exploration

The existing tier-2 commit path (`applyOps` in `src/lib/proof/ops-applier.ts:457`) already
IS the `exact` preflight policy for the parts that matter:

- It compares `baseRevision` to `sidecar.revision` and returns `409 STALE_REVISION` on mismatch
  (`ops-applier.ts:509-523`).
- It resolves the target `blockRef` via `resolveRef`; a vanished ref fails the op.
- AI writers (`by: "ai:<id>"`) already get `activity record` wrapping (`cleanMarkdownCommit`,
  `ops-applier.ts:94-160`) with a `ActivityAttrs` that already carries `inResponseTo`.
- The HTTP route `POST /api/agent/files/[...path]` already enforces `Idempotency-Key`
  (route.ts:96-132): same key + same payload returns the cached response; same key + different
  payload returns `409 IDEMPOTENCY_KEY_REUSED`.

Therefore the live channel adds **no new write path and no schema change to the commit
engine**. It is a control plane that:

1. carries a human's intent (selected block + instruction) to an attached agent, and
2. tracks the session/request lifecycle,

while the agent performs the edit through the existing `POST /api/agent/files/[...path]` with:

- `Idempotency-Key: live:<requestId>` (deterministic replay safety), and
- op `inResponseTo: "live:<requestId>"` (provenance correlation into `ActivityAttrs.inResponseTo`).

The editor already reloads snapshot+sidecar via the browser SSE filesystem watch
(`use-document-watch.ts:55-77`) when `applyOps` writes the `.md`, so the live channel does
**not** push edits to the client. It only carries intent to the agent and lifecycle to both.

This keeps us strictly in "stance 1": one commit engine, live path is exact-fail-closed by
reusing `applyOps` as-is. The `recover` machinery stays for async/MCP and is untouched.

## Components

### 1. Live store — `src/lib/proof/live/store.ts`

SQLite, following `src/lib/shared-docs/db.ts` (lazy singleton, WAL, inline
`CREATE TABLE IF NOT EXISTS`). New db file `~/.wiki-viewer/live.db`.

```
live_session(
  id TEXT PRIMARY KEY,           -- session id
  workspace_id TEXT NOT NULL,
  agent_id TEXT,                 -- attached agent, null until attach
  state TEXT NOT NULL,           -- 'open' | 'closed'
  created_at INTEGER NOT NULL,
  agent_last_seen INTEGER        -- updated each long-poll; presence/lease
)

live_request(
  id TEXT PRIMARY KEY,           -- request id -> Idempotency-Key live:<id>
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,            -- relative md path
  block_ref TEXT,               -- selected block (null for steer/accept/discard)
  base_revision INTEGER,        -- revision at selection time
  kind TEXT NOT NULL,           -- 'generate' | 'steer' | 'accept' | 'discard' | 'exit'
  instruction TEXT,             -- freeform prompt (generate/steer)
  state TEXT NOT NULL,          -- 'pending' | 'delivered' | 'working' | 'resolved' | 'stale' | 'error'
  outcome TEXT,                 -- 'accepted' | 'reverted' | null
  seq INTEGER NOT NULL,         -- monotonic per workspace for ordered delivery
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  resolved_at INTEGER
)
```

Store API (sync, better-sqlite3-style wrapper `src/lib/sqlite.ts`):
`openOrGetSession`, `attachAgent`, `touchAgent`, `closeSession`, `enqueueRequest`,
`nextPendingRequest(workspaceId, afterSeq)`, `markDelivered`, `markState`, `getSession`,
`getRequest`, `latestOpenSessionForWorkspace`.

Presence rule: an agent is "attached" if a session has `agent_id` set and
`agent_last_seen` within a lease TTL (e.g. 45s). No separate heartbeat; the held long-poll
updates `agent_last_seen`.

### 2. Agent-facing transport — `src/app/api/agent/live/`

All routes: `checkAuth(req)` -> `resolveWorkspaceForAgent(req)` -> `enforceScope(...)`.

- `POST /api/agent/live/attach` — body `{ sessionId? }`. Creates/attaches a session for the
  agent+workspace, returns `{ sessionId }`. Idempotent per agent+workspace (reuses latest open
  session).
- `GET /api/agent/live/poll?sessionId=&afterSeq=` — **long-poll**. Held open up to ~25s using
  a `ReadableStream`-free promise+interval loop (mirrors the heartbeat pattern of
  `/api/wiki/watch/route.ts:274`). On each tick, `touchAgent` and check
  `nextPendingRequest`; when found, `markDelivered` and return the event JSON `{ type, request }`;
  on timeout return `{ type: "timeout" }`. This held request IS presence.
- `POST /api/agent/live/reply` — body `{ requestId, status }` where status is
  `working | done | error`. Updates `live_request.state`. `done` on a generate/steer means the
  agent finished committing (the actual edit already landed via tier-2).

The agent commits the edit itself via existing `POST /api/agent/files/[...path]` with the
deterministic idempotency key and `inResponseTo`. The live channel never writes files.

### 3. Human-facing dispatch — `src/app/api/wiki/live/`

Session-authed (Better Auth), CSRF-checked like other `/api/wiki/*` mutations.

- `POST /api/wiki/live/request` — body `{ path, blockRef?, baseRevision?, kind, instruction? }`.
  Resolves the workspace for the user, finds/creates the open session, enqueues a
  `live_request`. Returns `{ requestId, seq }`.
- `GET /api/wiki/live/status?path=` — returns `{ attached: boolean, session, lastRequest }`
  so the editor can show whether an agent is on the line and the current turn state.

Accept/revert are dispatched here too (`kind: 'accept' | 'discard'`) purely as notifications
to the session; the actual activity tracking of the activity/audit provenance happens through the existing editor
suggestion/proof UI and its normal API.

### 4. Editor UI — `src/components/editor/`

- Add `onAskAgent` to `EditorBubbleMenu` (bubble-menu.tsx) beside `onSuggestEdit`/`onComment`.
- In `editor.tsx`, implement `openAskAgentForSelection()` using existing `resolveSelectionBlock()`
  (editor.tsx:236) to get `{ blockRef, markdown }`, plus `currentPath` and current snapshot
  `revision`. Open a small popover to type the instruction, then
  `POST /api/wiki/live/request { kind: 'generate', path, blockRef, baseRevision, instruction }`.
- A minimal "Live" status indicator (attached / waiting / working) driven by
  `GET /api/wiki/live/status`. Steer = same popover again while a turn is open.
- Proof-span appears through the existing SSE-watch reload; activity tracking use existing UI.

## Correctness

- **Stale intent:** the request stores `base_revision` at selection time. The agent must POST
  with that `baseRevision`. If the human edited meanwhile, `applyOps` returns `STALE_REVISION`;
  the agent replies `error`, the request is marked `stale`, UI asks for a fresh selection. No
  silent re-interpretation.
- **Replay:** `Idempotency-Key = live:<requestId>` makes a re-POST after agent crash return the
  cached result; no duplicate edit. The request id is stable in `live_request`, so recovery
  reuses it.
- **One outstanding request per session:** `enqueueRequest` rejects a new `generate` while the
  session has a non-terminal request. Reviewer-approved v1 constraint.
- **Presence ambiguity:** `agent_last_seen` + TTL. Timeout => not attached. Reconnect resumes
  from `afterSeq` (last delivered seq).

## What we deliberately do NOT build

Restated from proposal non-goals; enforced in review: no helper server, no injected JS, no HMR,
no variants, no second write path / `applyLiveEdit`, no async-machinery deletion, no fuzzy
recovery on the live path.
