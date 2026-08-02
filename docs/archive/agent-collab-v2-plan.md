# Agent Collaboration Protocol — v2 Implementation Plan

**Status:** Draft for review. Do not implement until user signs off.
**Target:** Pivot wiki-viewer from single-user local-first to multi-user remote-server with realtime CRDT collab.
**Audience:** Implementing agent, with no prior context, who has read `docs/agent-collab-plan.md` (v1) for reference.
**Relationship to v1:** v1 stays as historical reference. v2 supersedes §0 prohibition on Yjs and §0 single-user constraint. The HTTP agent surface, op vocabulary, sidecar shape, and provenance marks survive in modified form. The file-on-disk-is-truth rule is loosened (see §1.3).

---

## 0. What changed since v1

| v1 axiom                                       | v2 status                                                                                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-user, local-first                       | **REVERSED** — multi-user, remote-server first                                                                                                                             |
| File on disk is source of truth, always        | **REFINED** — Y.Doc is source of truth during live session; markdown is durable export + cold-start seed                                                                   |
| No Yjs, no WebSockets, no realtime CRDT        | **REVERSED** — Yjs + Hocuspocus realtime, y-prosemirror binding                                                                                                            |
| Bearer token + owner cookie                    | **REPLACED** — OAuth (GitHub primary, Google secondary), session in DB, per-user identity                                                                                  |
| Single ROOT_DIR                                | **REPLACED** — workspace entity with member ACL                                                                                                                            |
| Agent registry in `~/.wiki-viewer/agents.json` | **REPLACED** — per-workspace agent rows in DB                                                                                                                              |
| In-process mutex serializes mutations          | **KEPT for cold path** — Y.Doc handles concurrent edits, server applies agent ops as Y transactions; mutex still guards persistence-flush and external-edit reconciliation |
| `PUT /api/wiki/content` bypasses ops-applier   | **FIXED** — editor never writes raw markdown; saves go through Y.Doc                                                                                                       |
| Pending registrations in-memory                | **REPLACED** — DB-backed                                                                                                                                                   |
| No HTTPS / no CSRF                             | **FIXED** — enforce HTTPS in prod, CSRF on owner-cookie POSTs (now session-cookie POSTs), Origin check on WS upgrade                                                       |
| No presence, no live cursors                   | **ADDED** — Yjs awareness                                                                                                                                                  |

What stays:

- TipTap editor (no Milkdown swap)
- proof-span mark (now lives inside Y.XmlFragment)
- Block-ref + idempotency semantics on the HTTP surface (agents see no API break for their core ops, only auth/scope)
- Sidecar concept (comments, suggestions, events, blockProvenance) — migrates from JSON files to DB rows
- 160-test suite via `node --test` / `tsx --test` — augmented, not replaced

---

## 1. Architecture sketch

### 1.1 Block diagram (post-pivot)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Browser (User)                                │
│                                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐   │
│  │  Next.js app                                                       │   │
│  │  ┌──────────────────────┐    ┌──────────────────────────────────┐ │   │
│  │  │  TipTap editor       │◄──►│  y-prosemirror binding           │ │   │
│  │  │  + ProofSpan mark    │    │  + @tiptap/extension-collab      │ │   │
│  │  │  + suggestion cards  │    │  + Y.Doc (per file, in-memory)   │ │   │
│  │  │  + comment pips      │    └────────────────┬─────────────────┘ │   │
│  │  │  + presence cursors  │                     │                   │   │
│  │  └──────────────────────┘                     │                   │   │
│  │  ┌──────────────────────┐                     │                   │   │
│  │  │  Sidecar REST client │◄────────────────────┼───── y-protocol   │   │
│  │  │  (comments, sugg.,   │                     │      messages     │   │
│  │  │   events polling)    │                     │                   │   │
│  │  └──────────────────────┘                     │                   │   │
│  └────────────────────────────────────────────────┼───────────────────┘   │
│                  HTTPS │ session cookie         WSS │ session cookie       │
└──────────────────────────┼───────────────────────────┼───────────────────┘
                           │                           │
┌──────────────────────────▼───────────────────────────▼───────────────────┐
│                       Node process (custom server.ts)                   │
│                                                                          │
│  ┌─────────────────────────────────┐   ┌───────────────────────────────┐ │
│  │  Next.js HTTP handler           │   │  Hocuspocus (mounted on /yjs) │ │
│  │   - /api/auth/*  (OAuth)        │   │   onAuthenticate → session    │ │
│  │   - /api/workspaces/*           │   │   onLoadDocument → seed Y.Doc │ │
│  │   - /api/agent/* (HTTP bridge)  │   │     from markdown OR DB blob  │ │
│  │   - /api/wiki/* (read-only file │   │   onChange → debounced flush  │ │
│  │      tree, content GET)         │   │     → markdown + commit to    │ │
│  │   - /api/sidecar/*              │   │     workspace store + DB blob │ │
│  └────────────────┬────────────────┘   │   onDisconnect → presence rm  │ │
│                   │                    └────────────┬──────────────────┘ │
│                   │                                 │                    │
│  ┌────────────────▼─────────────────────────────────▼──────────────────┐ │
│  │              Server-side proof core (refactored)                    │ │
│  │   - ops-applier-yjs.ts  (translates Op → Y.Doc transaction)         │ │
│  │   - block-refs.ts       (now reads block list from Y.Doc snapshot)  │ │
│  │   - sidecar-store.ts    (DB-backed; legacy JSON read for migration) │ │
│  │   - mutex.ts            (per-doc serial for flush + agent ops batch)│ │
│  └─────────────┬──────────────────────────────┬────────────────────────┘ │
│                │                              │                          │
│  ┌─────────────▼──────────┐    ┌──────────────▼──────────────────────┐   │
│  │  Postgres (or SQLite)  │    │  File-system store (per workspace)  │   │
│  │   users                │    │   <workspace_root>/<path>.md        │   │
│  │   sessions             │    │   (debounced flush from Y.Doc,       │   │
│  │   workspaces           │    │    chokidar watches for external)   │   │
│  │   workspace_members    │    └──────────────────────────────────────┘   │
│  │   agent_registrations  │                                              │
│  │   agent_records        │                                              │
│  │   comments             │                                              │
│  │   suggestions          │                                              │
│  │   events               │                                              │
│  │   ydoc_snapshots       │   ← optional: persisted Yjs state vectors   │
│  └────────────────────────┘                                              │
└──────────────────────────────────────────────────────────────────────────┘
              ▲
              │ HTTPS (Authorization: Bearer <agent-token>)
              │
   ┌──────────┴──────────┐
   │ Remote AI agent     │  (Claude, Cursor, ChatGPT desktop, etc.)
   │ uses /api/agent/*   │  Sees blocks + revision, NOT raw Yjs protocol.
   └─────────────────────┘
```

### 1.2 Yjs provider choice

Pick: **Hocuspocus**.

| Option                   | Why not / why yes                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `y-protocols` + `ws` | Too low-level. Need to reimplement onAuthenticate, onLoadDocument, onStore, debounced persistence, awareness routing, hooks. Reinventing Hocuspocus.                                                                                                                                                                                                                                                                                                                                     |
| `y-websocket` server     | Good enough for happy path, but auth hook is `gc`-only, no built-in onLoadDocument/onStore hooks tuned for our flush model, no extension API. Adopted then abandoned by many teams.                                                                                                                                                                                                                                                                                                      |
| **Hocuspocus**           | Built for this. First-class hooks: `onAuthenticate`, `onConnect`, `onLoadDocument`, `onChange`, `onStoreDocument`, `onDisconnect`. Cleanly mountable inside a custom Next.js server. MIT, actively maintained. Extension ecosystem (`@hocuspocus/extension-database`, `@hocuspocus/extension-throttle`, `@hocuspocus/extension-logger`) overlaps with our needs. Cost: ships a chunky server bundle and ties our persistence to its hook lifecycle, but the lifecycle matches our model. |

Trade-off accepted: Hocuspocus binds us to a specific Yjs server vendor. Escape hatch: ops-applier-yjs and persistence sink live in our code; Hocuspocus is a thin transport layer. We can swap to a custom y-protocols server later without rewriting business logic.

### 1.3 Where does the markdown file fit?

**Rule (explicit):**

1. **Y.Doc is the live truth** during any active editing session for a given file. All edits (human, agent) land in the Y.Doc first.
2. **Markdown on disk is durable export + cold seed.** When a Y.Doc has no awareness connections for `IDLE_FLUSH_MS` (default 30s), or on graceful shutdown, server serializes Y.Doc to markdown and writes the file. File commit is also debounced during the live session (`LIVE_FLUSH_MS`, default 5s) so external tools see fresh content.
3. **DB stores the canonical Yjs state vector** + a debounced markdown snapshot blob in `ydoc_snapshots`. The file system markdown is regenerated from DB on every flush. The on-disk file is for: git, chokidar consumers, command-line tools, downloads.
4. **On document open with no live session:** if `ydoc_snapshots` has rows, load latest snapshot's Y.Doc state and continue. If not, parse markdown from disk → seed Y.Doc → write snapshot. (This is the migration path from v1 sidecars.)
5. **External edit (vim) while doc is live:** chokidar fires. Server's `onExternalFileChange` handler computes diff between current Y.Doc serialization and new file content. If different, **the external edit wins** by being applied as a Yjs transaction (using `applyMarkdownAsYjsTransaction`, which diffs at block granularity to minimize churn). This emits a `file.externallyEdited` event and shows a toast in the editor. Rationale: vim user explicitly typed those bytes; refusing them would be confusing.
6. **External edit while doc is NOT live:** trivial. Next open seeds from disk, which is now newer than the last `ydoc_snapshots` row.

This is the **single hardest design decision** in v2. Document it in `docs/file-vs-yjs-authority.md` with examples before phase F.

---

## 2. Persistence model

### 2.1 Y.Doc lifecycle per file

| Phase                  | Action                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First open ever        | `parseBlocks(md)` → for each block, create a Y.XmlElement with attributes `data-ref=<ref>` and content. Wrap into the doc's primary Y.XmlFragment named `default`. Write initial snapshot to `ydoc_snapshots`.     |
| Reopen with snapshot   | `Y.applyUpdate(doc, snapshot.update)`. Skip markdown parse.                                                                                                                                                        |
| Live edits             | Editor's y-prosemirror binding applies Y.Doc updates. Awareness updates broadcast cursors / users.                                                                                                                 |
| Debounced live flush   | Every `LIVE_FLUSH_MS` or on quiet window of `IDLE_FLUSH_MS`: serialize Y.Doc → markdown via `yDocToMarkdown()`, write `<workspace_root>/<path>.md`, upsert `ydoc_snapshots` row with `Y.encodeStateAsUpdate(doc)`. |
| External edit detected | Reconcile (§1.3.5).                                                                                                                                                                                                |
| All clients disconnect | Schedule full flush + idle eviction after `IDLE_EVICT_MS` (default 5 min). After eviction, Y.Doc unloaded from memory; next open reseeds.                                                                          |

### 2.2 Sidecar migration

v1 stored comments / suggestions / events / refMap / blockProvenance in `<root>/.proof/<path>.json`. v2:

- **Comments, suggestions, events, blockProvenance** → DB rows keyed by `(workspace_id, path)`. See §5.2 schema.
- **refMap, refAliases** → no longer stored. Refs are derived from current Y.Doc state: each block-level Y.XmlElement carries `data-ref` attribute, stable across edits to its content (the ref is set at insertion time and survives content edits because we attach it to the element node, not its text).
- **lastAck** → DB column on `agent_records` keyed by `(agent_id, workspace_id, path)`.

Recommendation: **drop sidecar JSON entirely.** Migrate existing files at first read: if `.proof/<path>.json` exists, import into DB, then leave the file in place (read-only, ignored) for safety. After 2 weeks of green prod, delete migration code.

### 2.3 Agent block-ref + revision model under Yjs

This is the second hardest design decision. Two truths to reconcile:

- Agents send `baseRevision: N` and expect 409 STALE_REVISION if the doc moved.
- Yjs has no monotonic per-doc revision; it has a state vector (a `Map<clientId, clock>`) representing the latest seen update per peer.

**Approach (Proof-SDK-inspired): mutationBaseToken**

When an agent calls `GET /api/agent/files/<workspace>/<path>`, the response includes:

```json
{
  "revision": 47,
  "mutationBaseToken": "<base64-state-vector>",
  "blocks": [ { "ref": "b7f2c1", ... }, ... ]
}
```

- `revision` is still a monotonic integer maintained per (workspace, path) in DB. Bumped only when ops-applier-yjs commits an agent ops batch. Human edits do NOT bump this counter (they're CRDT; no agent should care).
- `mutationBaseToken` is `Y.encodeStateVector(doc)` base64-encoded. Carries far more information than `revision`; tells us exactly what the agent saw.

When agent POSTs ops with `baseRevision: 47` and (optionally) `mutationBaseToken`:

1. Check `revision === 47` — if not, return STALE_REVISION with fresh snapshot.
2. Optionally validate `mutationBaseToken` matches current state vector. If matches: pure forward agent op, no human edits since. If doesn't match: humans typed since the snapshot. Apply the agent ops anyway — Yjs CRDT will merge — but include a warning header `X-Concurrent-Human-Edits: true` so agent SDKs can log it.
3. Each block ref in the ops is resolved against current Y.Doc state (the `data-ref` attribute on element nodes). If missing, return BLOCK_NOT_FOUND with fresh snapshot.

**Implication for agents:** v1's block-ref-not-found error becomes much rarer because content edits don't invalidate refs. Only deletions do.

---

## 3. Multi-user identity

### 3.1 Auth library choice

Pick: **NextAuth.js v5 (Auth.js)**.

| Option            | Verdict                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NextAuth v5**   | Mature, OAuth providers are config-only, supports DB sessions with Drizzle adapter, integrates with App Router middleware cleanly, has been battle-tested on Next 14/15/16. Cost: opinionated session shape, bundle weight. |
| lucia-auth        | Smaller, more flexible, but author paused active development and recommended migrating away. Don't bet on it.                                                                                                               |
| Hand-rolled OAuth | We'd reimplement: provider URL builders, state cookie, PKCE, JWT signing, refresh rotation. Each is a security landmine. Reject.                                                                                            |

**Session storage:** **DB sessions, not JWT.** Reasons:

- Logout-anywhere is a real requirement
- Session revocation on permission change
- Token refresh rotation easier with DB
- JWT cookies become large; DB sessions remain a short opaque ID

**Cookie:** `__Host-session` in prod, `next-auth.session-token` semantics. HttpOnly, SameSite=Lax, Secure in prod.

### 3.2 User record schema (Drizzle pseudo)

```
users
  id            uuid primary key
  email         text not null unique
  display_name  text not null
  avatar_url    text
  created_at    timestamptz default now()

oauth_accounts
  id              uuid primary key
  user_id         uuid references users on delete cascade
  provider        text not null   -- "github" | "google"
  provider_sub    text not null   -- subject id from provider
  access_token    text            -- encrypted at rest (later phase)
  refresh_token   text            -- encrypted at rest
  expires_at      timestamptz
  unique (provider, provider_sub)

sessions
  id            text primary key   -- random 32 bytes b64u
  user_id       uuid references users on delete cascade
  expires_at    timestamptz not null
  created_at    timestamptz default now()
  last_seen     timestamptz default now()
```

### 3.3 Identity threading

| Surface                     | How identity flows                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP request                | Session cookie → middleware → `req.user` (uid, email, displayName)                                                                                                                      |
| Yjs WebSocket               | `onAuthenticate({ token })` token is the session cookie value; server validates same way → resolves user; injected into `context.user`. Awareness sets `{ user: { id, name, color } }`. |
| proof-span `by` attribute   | Now `"user:<uuid>"` for humans (was `"human"`), `"ai:<agent-id>"` for agents. v1 `"human"` value preserved during read for back-compat in old files (mapped to `"user:legacy"`).        |
| Agent HTTP `by` field       | Must equal authenticated agent's id (already enforced by `verifyBy`). Browser-driven mutations (suggestion accept, span accept) use `by: "user:<uuid>"`.                                |
| Agent registration approval | Whoever owns the workspace approves. Workspace admins can approve. Pending registrations carry the requested workspace_id.                                                              |
| Agent registry ownership    | Each agent record is `(workspace_id, agent_id)` keyed. Tokens are workspace-scoped.                                                                                                     |

---

## 4. Workspace model

### 4.1 Workspaces as first-class entity

```
workspaces
  id              uuid primary key
  name            text not null
  root_path       text not null      -- absolute on server
  created_by      uuid references users
  created_at      timestamptz default now()
  visibility      enum('private', 'invite_only')  default 'invite_only'

workspace_members
  workspace_id    uuid references workspaces on delete cascade
  user_id         uuid references users on delete cascade
  role            enum('admin', 'editor', 'viewer') not null
  added_at        timestamptz default now()
  primary key (workspace_id, user_id)
```

- All files live under `<workspaces.root_path>/`. Server enforces traversal protection (current `safeRootPath` generalizes to `safeWorkspacePath(workspace_id, rel)`).
- A user with no membership row gets 404 on the workspace (do not leak existence via 403).
- `admin` can: invite/remove members, register agents, change visibility, delete workspace.
- `editor` can: read + write files, manage comments/suggestions, mention agents.
- `viewer` can: read only. Read-only Y.Doc connection (Hocuspocus supports `readOnly: true` in onAuthenticate).

### 4.2 Path namespacing

URLs become `/w/<workspace_slug>/<file-path>`. API:

- `/api/workspaces/<workspace_id>/files/<path>` (catch-all)
- `/api/workspaces/<workspace_id>/agent/files/<path>` (agent HTTP surface, see §7)
- WS: `wss://<host>/yjs/<workspace_id>/<path>`

Slug or UUID in URL? Use **slug** for human URLs (`/w/team-notes/plan.md`), **UUID** under the hood (resolved server-side in middleware). Keeps URLs nice without leaking enumerable IDs.

### 4.3 Agent registry under workspace

```
agent_records
  id              text primary key            -- agent slug, e.g. "claude-1"
  workspace_id    uuid references workspaces on delete cascade
  display_name    text not null
  token_hash      text not null              -- sha256 of plaintext
  scope_paths     jsonb not null             -- string[] glob
  scope_ops       jsonb not null             -- ('read'|'mutate')[]
  created_by      uuid references users
  created_at      timestamptz default now()
  last_seen       timestamptz
  unique (workspace_id, id)
```

Token check becomes: lookup by hash → find row → check workspace + match `X-Agent-Id` to row id.

`agent_registrations` table mirrors `pending.ts` but DB-backed (rows pruned after TTL).

---

## 5. Database

### 5.1 Engine choice

Pick: **Postgres** (managed; e.g., Neon, Supabase, or Railway).

Rationale:

- User says "remote server, multi-user". SQLite single-writer model becomes a bottleneck under realtime workloads where Hocuspocus may write `ydoc_snapshots` every 5s per active file.
- WS server may run as multiple replicas; SQLite + multiple writers = pain. Postgres handles concurrent writes natively.
- LISTEN/NOTIFY useful for fan-out of events to non-WS subscribers (later).
- Drizzle ORM has identical TS API for both, so swap cost is low if user prefers SQLite later.

**Fallback for small deploys:** keep SQLite as an option via drizzle's dialect switch. Migrations written to both. Defaulted off; documented.

### 5.2 Full schema (concise)

```
users (§3.2)
oauth_accounts (§3.2)
sessions (§3.2)
workspaces (§4.1)
workspace_members (§4.1)
agent_records (§4.3)

agent_registrations
  id            text primary key   -- registration code
  workspace_id  uuid references workspaces on delete cascade
  payload       jsonb              -- display_name, requested scope
  status        enum('pending','approved','rejected','expired') default 'pending'
  approved_by   uuid references users
  approved_at   timestamptz
  expires_at    timestamptz
  created_at    timestamptz default now()

comments
  id            text primary key                -- "c" + hex
  workspace_id  uuid references workspaces on delete cascade
  path          text not null
  block_ref     text not null
  resolved      boolean default false
  created_at    timestamptz default now()
  unique (workspace_id, path, id)

comment_turns
  id            bigserial primary key
  comment_id    text references comments on delete cascade
  by            text not null
  text          text not null
  at            timestamptz default now()

suggestions
  id            text primary key
  workspace_id  uuid references workspaces on delete cascade
  path          text not null
  block_ref     text not null
  kind          text not null
  status        text not null
  by            text not null
  markdown      text
  basis         text
  basis_detail  text
  created_at    timestamptz default now()
  resolved_at   timestamptz
  resolved_by   text
  unique (workspace_id, path, id)

events
  id            bigserial primary key
  workspace_id  uuid references workspaces on delete cascade
  path          text not null
  seq           bigint not null              -- monotonic per (workspace, path)
  type          text not null
  by            text not null
  at            timestamptz default now()
  payload       jsonb
  unique (workspace_id, path, seq)

ack_cursors
  workspace_id  uuid
  path          text
  by            text                          -- agent id
  up_to         bigint                        -- event seq
  primary key (workspace_id, path, by)

ydoc_snapshots
  workspace_id  uuid
  path          text
  taken_at      timestamptz default now()
  state_update  bytea                         -- Y.encodeStateAsUpdate
  primary key (workspace_id, path)

block_provenance
  workspace_id  uuid
  path          text
  block_ref     text
  attrs         jsonb                         -- SpanAttrs for non-wrappable blocks
  primary key (workspace_id, path, block_ref)
```

Files (the markdown bytes) stay on disk. No `files` table needed; the file tree under each workspace root is the source of fileness.

### 5.3 Migrations: Drizzle

Pick: **Drizzle ORM + drizzle-kit**.

| Option             | Verdict                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drizzle**        | TS-first schemas, lightweight, no runtime overhead, generates SQL migrations as files, works with both Postgres and SQLite. NextAuth has a Drizzle adapter. Recommended for greenfield TS projects. |
| Prisma             | Heavier, slower start, opinionated client generation, less control. Reject.                                                                                                                         |
| Kysely             | Beautiful query builder, no migration story (drizzle's `drizzle-kit` is the closest equivalent and tighter).                                                                                        |
| Raw SQL + a runner | Tempting but reintroduces bugs we already get for free. Reject.                                                                                                                                     |

Migration command in `package.json`: `db:generate`, `db:push`, `db:migrate`. Add to `scripts`.

---

## 6. Realtime transport

### 6.1 Co-location vs separate process

**Pick co-location** via custom `server.ts`:

```ts
// server.ts (sketch)
const httpServer = http.createServer(nextHandler);
const hocuspocus = Hocuspocus.configure({
  extensions: [database, throttle, logger],
  onAuthenticate,
  onLoadDocument,
  onChange,
  onStoreDocument,
  onDisconnect,
});
hocuspocus.attachWebSocketServer(httpServer, { path: "/yjs" });
httpServer.listen(PORT);
```

Reasons for co-location:

- One process = one session model = one deploy unit
- WS upgrade and HTTP go through the same TLS cert / domain (no CORS, no cross-origin cookies)
- Hocuspocus's API is designed for this mounting style

Cost: lose Next.js' built-in `next start` ergonomics. We replace with `node server.ts`. Document this.

Alternative if WS scaling becomes a problem: factor Hocuspocus into a separate process behind the same reverse proxy, use Postgres or Redis as the cross-replica sync layer (`@hocuspocus/extension-database` supports this). Not in v2 scope.

### 6.2 Auth gate on WS upgrade

```ts
async onAuthenticate({ token, documentName, request }) {
  const session = await verifySessionCookie(token);
  if (!session) throw new Error('UNAUTHORIZED');

  const [workspaceId, ...pathParts] = documentName.split('/');
  const role = await getMemberRole(workspaceId, session.user.id);
  if (!role) throw new Error('FORBIDDEN');

  const origin = request.headers.origin;
  if (!isAllowedOrigin(origin)) throw new Error('FORBIDDEN_ORIGIN');

  return {
    user: { id: session.user.id, name: session.user.displayName, color: hashColor(session.user.id) },
    workspaceId,
    path: pathParts.join('/'),
    readOnly: role === 'viewer'
  };
}
```

Browser side: y-hocuspocus provider's `token` param holds session cookie. Or, simpler — since same-origin WS auto-sends cookies, parse the cookie server-side in `onAuthenticate({ request })`. Pick whichever Hocuspocus's API exposes cleanly; document the choice in `server.ts`.

### 6.3 Awareness contract

Each connection's awareness state:

```ts
{
  user: { id: string, name: string, color: string },
  cursor?: { anchor: number, head: number },
  typing?: boolean
}
```

- Color: deterministic from user id (`hashColor`), 12-color palette tuned for the editor's dark + light themes. Same user same color across reconnects.
- Display name: from session.
- Cursors render via `y-prosemirror`'s built-in `yCursorPlugin`. Configure to render small caret bar + tag with name on hover.
- Typing indicator (optional polish): set true on input, debounce-clear after 1s. Not strictly necessary v2.

---

## 7. Agent bridge changes

### 7.1 Two architectural options

**Option A: HTTP-only agent surface, server compiles ops to Y.Doc transactions.** (chosen)

```
Agent ─HTTP POST /api/agent/files─► route
                                    │
                                    ├─ verify auth + scope + by
                                    ├─ open Y.Doc (load from in-memory pool or rehydrate from snapshot)
                                    ├─ check baseRevision
                                    ├─ ops-applier-yjs.applyOps(ops, ydoc, { actor })
                                    │    - for each block.* op: mutate Y.XmlFragment within doc.transact()
                                    │    - for each comment.* / suggestion.* op: DB row update
                                    │    - emit events
                                    │    - wrap proof-spans inline as Y nodes
                                    ├─ bump revision counter (DB)
                                    ├─ schedule flush (markdown serialize + ydoc_snapshot upsert)
                                    └─ return new Snapshot
```

The transact's awareness identity is set to a synthetic clientId reserved for the agent (e.g. negative integers per agent id, deterministic). Browser sees the edit live via Hocuspocus broadcast; cursors show "claude is editing" via awareness if the agent also pushes presence.

**Option B: Agent has its own Yjs client connection.** (rejected)

| Pro                      | Con                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Agent gets realtime echo | Agent SDK becomes 10x more complex (must speak y-protocols)                                                          |
|                          | Agent can no longer be "just curl"                                                                                   |
|                          | Breaks v1 skill / bootstrap-prompt entirely                                                                          |
|                          | No clear win — agents don't need to see human keystrokes in real time; polling events catches comment additions etc. |

**Decision: Option A.** Existing skill/bootstrap-prompt survives unchanged in shape; only the workspace prefix on URLs is new and the bearer token replaces env-token semantics.

### 7.2 baseRevision becomes mutationBaseToken (or stays revision)

Both are returned. Agents that send only `baseRevision` still work. Newer agents may send `mutationBaseToken` for finer-grained concurrency awareness (§2.3).

### 7.3 proof-span behavior

Unchanged in shape. Wrapping logic moves: ops-applier-yjs constructs the proof-span as a Y.XmlElement (or as inline HTML inside a paragraph's Y.XmlText, depending on how y-prosemirror serializes ProofSpan marks).

**Important integration test (Phase 6):** insert a paragraph via agent → verify y-prosemirror renders the proof-span mark on the right text → verify markdown serialization emits the right HTML.

### 7.4 New agent endpoints

- `POST /api/workspaces/<wid>/agent/files/<path>` — same op vocab
- `GET /api/workspaces/<wid>/agent/files/<path>` — snapshot
- `GET /api/workspaces/<wid>/agent/events/<path>` — events
- `POST /api/workspaces/<wid>/agent/events/<path>` — ack
- `GET /api/workspaces/<wid>/agent/sidecar/<path>` — comments + suggestions JSON (now built from DB)

Backward compat shim: `GET /api/agent/files/<path>` redirects to `/api/workspaces/<default>/agent/files/<path>` for single-workspace deployments. Document deprecation.

---

## 8. Editor changes

### 8.1 Remove the htmlToMarkdown save loop

Current path: editor change → debounce → `htmlToMarkdown` → `PUT /api/wiki/content`. This bypasses the ops-applier and the revision counter — v1 known bug.

v2:

- Editor binds to Y.Doc via `@tiptap/extension-collaboration` + `y-prosemirror`.
- All edits land in Y.Doc → Hocuspocus broadcasts.
- Server's `onChange` debounces flush (§2.1).
- `PUT /api/wiki/content` becomes **read-only-or-removed**. Optionally keep for non-markdown files (json, ts, etc. that the editor still saves directly). For markdown files: return 410 Gone with message "use Yjs editor".

Editor's `editor-store.ts` simplifies: no debounced save side, just open/close Y.Doc connections.

### 8.2 ProofSpan mark stays

Definition unchanged. Y-prosemirror serializes marks fine. Verify with a Y.Doc round-trip test (§9 Phase 4).

### 8.3 Suggestion cards + comment pips read from DB

Currently they read from `useProofStore` populated by `GET /api/agent/sidecar/<path>`. v2: same store, same component code; underlying API now reads from DB rows. Almost zero React component change.

When a comment is added (by anyone), server emits an event AND pushes to a per-workspace SSE channel that the editor subscribes to → store updates → pip appears. (Could route via Hocuspocus message channel too, but SSE keeps comment state out of the Y.Doc, which is intentional.)

### 8.4 Markdown export

Server-side function `yDocToMarkdown(doc, { workspaceId, path })`:

1. Walk Y.XmlFragment → convert each block element to mdast node (reverse of v1's parse, with provenance attrs preserved on text marks).
2. Stringify via remark-stringify (same options as v1's `blocks.ts`).
3. Augment with block_provenance rows for non-wrappable blocks.

Used by:

- Debounced disk flush (§2.1)
- `GET /api/workspaces/<wid>/files/<path>?format=markdown` (read-only API)
- Git friendly view, downloads, mobile read-only mode if it ever ships

---

## 9. Concrete phase plan

Each phase ends with a green-test gate.

### Phase 1 — Auth: OAuth + sessions

- Add Drizzle + Postgres. Schema for users, oauth_accounts, sessions.
- Add NextAuth v5 with GitHub + Google providers. Drizzle adapter.
- Middleware that populates `req.user` from session cookie.
- Replace `wv_owner` cookie reads in routes with session reads.
- `/signin` page.
- **Tests:** session round-trip, OAuth mock callback creates user.
- **LoC ~700. Time ~1-2d.**
- **Gate:** sign in via GitHub, see name in header, sign out.

### Phase 2 — Workspaces + DB migration of registry

- Schema: workspaces, workspace_members, agent_records, agent_registrations.
- Migration script: read `~/.wiki-viewer/agents.json` → seed default workspace + agents.
- `/api/workspaces` CRUD.
- `safeRootPath` → `safeWorkspacePath(workspaceId, rel)`. Update consumers.
- DB-backed registry.
- **Tests:** workspaces.test, registry-db.test (ports of v1 registry tests).
- **LoC ~900. Time ~2d.**
- **Gate:** existing 160 + new tests green.

### Phase 3 — DB-backed sidecar

- Schema: comments, comment_turns, suggestions, events, ack_cursors, block_provenance.
- `lib/proof/sidecar-store.ts` DB-backed; same API as v1.
- ops-applier writes DB rows.
- Migration: import `.proof/*.json` into DB on first read.
- **Tests:** all v1 ops-applier/comments/suggestion/trim tests via in-mem DB.
- **LoC ~700. Time ~2d.**
- **Gate:** 160+ tests green.

### Phase 4 — Yjs server + flush sink (no editor binding yet)

- Add yjs, @hocuspocus/server, y-prosemirror, @tiptap/extension-collaboration.
- `server.ts` mounts Hocuspocus on `/yjs`.
- `lib/proof/yjs-store.ts`: loadDoc / flushDoc / closeDoc.
- `lib/proof/yjs-markdown.ts`: markdownToYjs, yDocToMarkdown.
- Chokidar reconciler (§1.3.5).
- WS auth (§6.2).
- **Tests:** yjs-roundtrip, yjs-external-edit, yjs-flush.
- **LoC ~1300. Time ~3d.**
- **Gate:** Y.Doc lifecycle tests green.

### Phase 5 — Editor binding + presence

- Replace save loop with y-prosemirror collab binding.
- Hocuspocus provider client.
- Cursor caret + name tag (yCursorPlugin).
- Presence avatar bar.
- Remove `PUT /api/wiki/content` for `.md`.
- **Tests:** editor-roundtrip via Y.Doc; manual two-tab test.
- **LoC ~600. Time ~2d.**
- **Gate:** two-tab live edit works.

### Phase 6 — Agent bridge port to Yjs

- `ops-applier.ts` → `ops-applier-yjs.ts`. `doc.transact()` for block ops.
- proof-span wrap via Y nodes.
- mutationBaseToken in snapshot.
- Routes under `/api/workspaces/<wid>/agent/*`; back-compat redirect.
- Update skill bootstrap-prompt for workspace prefix.
- **Tests:** rewrite ops-applier assertions to Y.Doc state; new concurrent-edits.test.
- **LoC ~1100. Time ~3d.**
- **Gate:** all proof tests green + concurrency test.

### Phase 7 — Realtime UI polish

- Per-block selection indicators.
- Comment SSE push for instant pip appearance.
- Suggestion live push.
- HTTPS enforcement, CSRF token, Origin check.
- **LoC ~500. Time ~2d.**

### Phase 8 — Hardening

- Rate limit WS connections per user.
- WS message size cap.
- Idle eviction tests.
- Snapshot pruning.
- Docs: README "running multi-user", `docs/file-vs-yjs-authority.md`.
- **LoC ~400. Time ~1-2d.**

**Total: ~6200 LoC, 16-18 working days.**

---

## 10. Risks + open questions

### 10.1 File vs Y.Doc authority

External edit during live session: external wins, applied as Yjs transaction. Risk: silent loss of unflushed Y.Doc edits. Mitigation: aggressive flush during active session.

### 10.2 Git commits during live editing

Commit captures whatever was flushed. Sample pre-commit hook calls `/api/flush`. Document, don't auto-install.

### 10.3 Bandwidth

Idle: few KB/s keepalive. Active edit: ~1-10 KB/s. 100 users ≈ 1 MB/s peak. Acceptable.

### 10.4 Suggestion lifecycle in CRDT

Accept applies Y.Doc transaction. If target block was deleted by human edit: BLOCK_NOT_FOUND, suggestion auto-archived "block_deleted".

### 10.5 Undo for AI-marked content

proof-span removal via Y.Doc transaction. Edge case: undo after human typed in span may restore mark over human content. Document and accept.

### 10.6 Open questions for user (before Phase 1)

1. Postgres OK, or insist on SQLite for solo deploys? (Recommend Postgres + SQLite-as-option.)
2. Managed Postgres (Neon/Supabase) or self-host?
3. GitHub + Google confirmed. Microsoft later? (No for v2.)
4. Workspace creation: anyone or admin-only? (Recommend: anyone creates their own; admins invite to existing.)
5. Editor for non-markdown files: keep `PUT /api/wiki/content`? (Yes.)
6. Browser localStorage Y.Doc persistence for offline read? (Not v2.)

---

## 11. Out of scope

- Mobile native app
- Offline editing without sync
- E2E encryption
- Plugin marketplace
- Search (full-text), tags
- Real-time voice/video
- File create/rename/delete via agent
- Multi-file agent ops
- Cross-workspace links
- Snapshot history browsing
- Audit log UI beyond event stream

---

## 12. Constraint compliance

| Constraint                              | v2                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Preserve agent HTTP contract            | Op vocab unchanged. URL gains `/workspaces/<wid>`. Skill ships with one-line path update. |
| Tests keep running                      | `node --test` / `tsx --test`. New tests follow pattern.                                   |
| 160 tests mostly survive                | Phases 1-3 port them. Phase 6 rewrites assertions, preserves cases. ≥150 survive.         |
| No big-bang                             | 8 phases each shippable. User can pause after Phase 3.                                    |
| Tabs, TS strict, no `any`, no em-dashes | Continued.                                                                                |

---

## 13. Definition of done

- Phases 1-8 merged
- All tests green incl. Phase 6 rewrites
- Two-tab live edit smoke passes
- External edit reconciliation smoke passes
- Agent skill updated + re-tested end-to-end
- `docs/file-vs-yjs-authority.md` reviewed
- README "running multi-user" section
- v1 plan (`docs/agent-collab-plan.md`) untouched

---

## 14. Critical files for implementation

- `src/lib/proof/ops-applier.ts` → becomes `ops-applier-yjs.ts`; biggest refactor
- `src/components/editor/editor.tsx` → replace save loop with y-prosemirror collab binding
- `src/lib/proof/registry.ts` → DB-backed per-workspace agent records
- `src/lib/proof/auth.ts` → session+OAuth gate, plus WS onAuthenticate
- `src/app/api/wiki/content/route.ts` → remove markdown PUT path that bypasses pipeline
