# Workspacing plan

> **Status: IMPLEMENTED.** Phases A–E complete. 294 tests pass, tsc clean.
> Key files: `src/lib/workspaces.ts`, `src/lib/workspace-context.ts`,
> `src/lib/auth/admin.ts`, `src/lib/workspace-client.ts`, workspace + admin
> APIs under `src/app/api/system/`, agent scope via `scope.workspaceId`.
> The legacy `src/lib/root-dir.ts` global is retained as a fallback source
> (synthetic default workspace) for `ROOT_DIR`/CLI/tests — not yet deleted.

## Goal

Let one running wiki-viewer serve multiple root directories ("workspaces")
concurrently, with zero state bleed between them. A user can have two tabs open
on two different workspaces at once. AI agents target a specific workspace.

Decisions (locked):

- **Selection**: URL/query carries `ws=<wsId>` for browser routes; agents send
  an `X-Workspace: <wsId>` header. No process-global "current root".
- **Agents are workspace-scoped**: every agent request resolves a workspace and
  is denied if it has no grant for it.
- **Isolation type**: organizational, not OS-level ACL. We add an explicit
  per-workspace access list (which users / which agents may use a workspace).
  We do NOT add per-user filesystem path restrictions on the directory browser.

## Why the current code bleeds

`src/lib/root-dir.ts` keeps a single `globalThis.__wikiRootDir`. Every route
calls `getRootDir()` / `safeRootPath()` against that one value, so:

- "Change" (`/api/system/clear-root`) wipes the root for every user/tab.
- Only one root can be active per process. No concurrency at all.

In-memory stores keyed by **relPath only** (collide across roots once more than
one root is live):

- `src/lib/proof/lease.ts` — `leases` + `generations` maps keyed by relPath.
- `src/lib/proof/idempotency.ts` — single LRU keyed by idempotency key.
- `src/lib/proof/mutex.ts` — in-process lock map keyed by relPath / mdPath.
- `src/lib/proof/file-lock.ts` — cross-process sentinel hashed from lockKey
  (relPath). Two workspaces with `notes.md` share one lock.

Config is single-root shaped:

- `src/lib/config.ts` — one `lastOpenedPath`, one flat `pinnedPaths`.

Already correctly scoped (these take `rootDir` as a param, keep as-is):

- `src/lib/proof/sidecar.ts`, `activity.ts` — read/write under
  `<rootDir>/.proof/`. Naturally isolated once `rootDir` is per-workspace.

Global, needs a `workspaceId` column / field:

- `src/lib/proof/audit.ts` — `agent_fs_audit` table mixes paths from all roots.
- `src/lib/proof/registry.ts` — `agents.json`; agent scope is path globs with
  no workspace dimension.

## Target architecture

### 0. Admin role (new prerequisite)

No admin concept exists today: every signed-in user is equal, and the settings
routes just `requireUser`. Workspace access management is admin-gated, so we
introduce a minimal global admin role.

New `src/lib/auth/admin.ts`:

```ts
isAdmin(userId, email): Promise<boolean>
listAdmins(): Promise<string[]>        // user ids
addAdmin(userId): Promise<void>
removeAdmin(userId): Promise<void>     // refuse to remove the last admin
requireAdmin(req): Promise<{ ok: true; user } | { ok: false; status; code }>
```

Resolution:

- `adminUserIds: string[]` stored in `config.json`.
- `WIKI_ADMIN_EMAILS` (csv) env: any matching signed-in user is treated as
  admin regardless of config (seed/override, headless-friendly).
- **Bootstrap**: if `adminUserIds` is empty AND no `WIKI_ADMIN_EMAILS`, the
  first user to sign up is written into `adminUserIds`. Hook the better-auth
  signup path, or do it lazily on the first authenticated request when the
  admin set is empty (behind the config write mutex). Log once.
- `requireAdmin` returns 403 `ADMIN_REQUIRED` for non-admins.

Admin management API: `GET/POST/DELETE /api/system/admins` (admin-gated; list
users, promote, demote). `DELETE` refuses to remove the last admin (lockout
guard). A small Admins section in the settings sheet lists users (from the
better-auth `user` table) with promote/demote toggles.

Non-admin users keep full file access to workspaces they are granted; admin is
only about creating workspaces and editing access lists (and promoting admins).

### 1. Workspace registry (replaces single rootDir)

New `src/lib/workspaces.ts`. Persisted in `~/.wiki-viewer/config.json` under a
new `workspaces` array. Each entry:

```ts
interface Workspace {
  id: string; // "ws_" + short random; stable, URL-safe
  name: string; // display label, defaults to basename(rootDir)
  rootDir: string; // absolute, resolved
  createdAt: string;
  lastOpenedAt?: string;
  pinnedPaths?: string[]; // moved here from the flat top-level list
  createdBy?: string; // user id of the admin who created it
  // access management (organizational, admin-edited only):
  allowedUserIds?: string[]; // empty/undefined = any signed-in user
  // agent grants live in the agent registry, keyed by workspaceId
}
```

API surface (pure functions, no globalThis root):

```ts
listWorkspaces(): Promise<Workspace[]>
getWorkspace(id): Promise<Workspace | null>
createWorkspace({ rootDir, name? }): Promise<Workspace>
renameWorkspace(id, name): Promise<void>
removeWorkspace(id): Promise<void>          // does NOT touch the directory
setWorkspaceAccess(id, userIds): Promise<void>   // admin-only, edits allowedUserIds
userCanAccess(ws, userId): boolean          // admins always pass; else allowedUserIds check
resolveWorkspaceRoot(id): Promise<string|null>
safeWorkspacePath(rootDir, rel): string|null   // the old safeRootPath logic
```

`safeRootPath` logic moves here as `safeWorkspacePath(rootDir, rel)` (takes an
explicit root instead of reading the global). Keep `root-dir.ts` as a thin
deprecated shim during migration if helpful, then delete.

### 2. Request-scoped workspace resolution

New `src/lib/workspace-context.ts`:

```ts
// Browser/session routes
async function resolveWorkspaceForUser(
  req,
): Promise<
  | { ok: true; ws: Workspace; rootDir: string }
  | { ok: false; status: number; code: string }
>;
```

Resolution order for browser routes:

1. `ws` query param (preferred) or `x-workspace` header.
2. If absent, fall back to the user's `lastOpenedAt` workspace (back-compat,
   single-workspace users never notice).
3. 400 `WORKSPACE_REQUIRED` if none and more than one workspace exists.

Then enforce `userCanAccess(ws, user.id)` → 403 `WORKSPACE_FORBIDDEN`.

For agent routes, `checkAuth` (in `src/lib/proof/auth.ts`) additionally reads
`X-Workspace`, looks up the workspace, and checks the agent's grant for it
(see §5). Returns `{ ok, agent, workspace, rootDir }`.

### 3. Namespacing the in-memory stores

Every store keyed by relPath becomes keyed by `wsId + "\0" + relPath` (the
workspace id is a stable prefix, NUL separator avoids collisions).

- `lease.ts`: `setLease`, `hasActiveLease`, `clearLease`, `leaseGeneration`
  gain a `wsId` first arg → internal key `${wsId}\0${relPath}`.
  `computeCollabState(rootDir, relPath)` already has rootDir; add `wsId` (or
  derive a key from rootDir — but explicit wsId is cleaner). Update
  `collab-state.ts` and `presence/route.ts` callers.
- `mutex.ts` / `file-lock.ts`: callers pass a key already; change every call
  site to prefix with `wsId` (e.g. `withFileMutex(`${wsId}\0${relPath}`, ...)`).
  Cross-process sentinel hash then differs per workspace automatically.
- `idempotency.ts`: prefix the key with `wsId` at the call site
  (`events/[...path]/route.ts`, `files/[...path]/route.ts`).
- `registry.ts` `lastSeenWriteAt` throttle map is keyed by agentId — fine, no
  change.

### 4. Threading rootDir through routes (29 files)

Pattern, every session route:

```ts
const ctx = await resolveWorkspaceForUser(request);
if (!ctx.ok)
  return NextResponse.json({ error: ctx.code }, { status: ctx.status });
const { ws, rootDir } = ctx;
const filePath = safeWorkspacePath(rootDir, rel);
```

Replace all `getRootDir()` → `ctx.rootDir`, `safeRootPath(rel)` →
`safeWorkspacePath(rootDir, rel)`, `isRootDirSet()` → existence of ctx.

Route inventory (all under `src/app/api`):

- `wiki/route.ts`, `wiki/content/route.ts`, `wiki/page/route.ts`,
  `wiki/slugs/route.ts`, `wiki/file/route.ts`, `wiki/new-file/route.ts`,
  `wiki/folder/route.ts`, `wiki/move/route.ts`, `wiki/upload/route.ts`,
  `wiki/download/route.ts`, `wiki/app/route.ts`, `wiki/watch/route.ts`,
  `wiki/presence/route.ts`
- `assets/[...path]/route.ts`, `upload/[...path]/route.ts`
- `system/reveal/route.ts`
- agent: `fs/file`, `fs/ls`, `fs/move`, `fs/search`, `files`, `events`,
  `sidecar`, `activity`, `settings`, `internal/span`

`watch/route.ts` (SSE / chokidar): watcher must watch `ws.rootDir`. Each EventSource
connection is per-workspace; the client opens `/api/wiki/watch?ws=<id>`.

### 5. Workspace-scoped agents

Agent grants gain a workspace dimension. In `registry.ts`:

```ts
interface AgentScope {
  workspaceId: string; // NEW — the workspace this grant applies to
  paths: string[];
  ops: Array<"read" | "mutate" | "delete">;
}
```

(An agent id may appear once per workspace, or scope becomes an array of
per-workspace grants. Simpler: one registry row per (agentId, workspaceId).
Recommend: keep `Agent.id` unique, add `workspaceId` to the record; an agent
that needs two workspaces registers twice.)

- `register` route: request body includes target `workspaceId`. Approval UI in
  the AI panel shows which workspace the request is for.
- `checkAuth`: resolve `X-Workspace`, then `enforceScope` also checks
  `agent.scope.workspaceId === ws.id`. Mismatch → 403.
- Browser session users (`user:<id>`) are synthesized in `checkAuth` with full
  scope; gate them with `userCanAccess(ws, userId)` instead.
- `audit.ts`: add `workspace_id` column to `agent_fs_audit`
  (`ALTER TABLE ... ADD COLUMN`; tolerate existing DBs). Write it on every row.

### 6. Config migration

On first read of `config.json` with the new code:

- If `workspaces` is absent but `lastOpenedPath` exists, synthesize one
  workspace `{ id: ws_*, rootDir: lastOpenedPath, name: basename, pinnedPaths:
config.pinnedPaths }` and mark it lastOpened. Keep old fields for one release
  for rollback safety; new writes use `workspaces`.
- `agents.json`: existing agents have no `workspaceId`. On load, backfill them
  to the migrated default workspace id (and log once, mirroring the existing
  legacy `ownerUserId` handling in the README checklist).

### 7. API: workspace management routes

New under `src/app/api/system/workspaces`:

- `GET  /api/system/workspaces` — list workspaces visible to the user
  (filtered by `userCanAccess`).
- `POST /api/system/workspaces` — create `{ rootDir, name? }` (validates dir
  exists, isDirectory). Replaces `set-root` semantics.
- `PATCH /api/system/workspaces/<id>` — rename / pin-unpin allowed for any
  user with access; **editing `allowedUserIds` is admin-only** (enforced field
  by field in the handler).
- `DELETE /api/system/workspaces/<id>` — **admin-only**. Unregister (directory
  untouched).

Workspace create (`POST`) is **admin-only** and sets `createdBy`. `GET` is open
to any signed-in user but filtered: admins see all, others see only workspaces
they can access. Admins management: `GET/POST/DELETE /api/system/admins`.

Deprecate / re-point: `set-root`, `clear-root`, `root-status`, `pins`. Keep
thin back-compat shims that operate on "the user's current/last workspace" so
nothing 404s mid-migration, then remove in a follow-up.

### 8. Client (browser)

- `src/app/page.tsx`: hold `activeWorkspaceId` in state. Read from URL `?ws=`
  first, else last opened. Put `ws` into every fetch (`/api/wiki?ws=...`,
  watch URL, presence body). Cleanest: a small `wsFetch(path, init)` helper /
  thin client store (`workspace-store.ts`) that injects `ws` automatically so
  we are not editing dozens of `fetch` calls by hand.
- Sidebar footer "Change" → opens a workspace switcher (list of workspaces the
  user may access). "Add workspace" (reuses `DirPicker`) is shown **only to
  admins**. Switching navigates to `?ws=<id>` (and `path` resets). Two tabs
  with different `?ws=` are fully independent.
- `DirPicker` (`src/components/dir-picker.tsx`): admin-only path. "Select" now
  POSTs `/api/system/workspaces` (create) instead of `set-root`, then routes
  to `?ws=<newId>`. Pins move under the chosen workspace.
- Settings sheet, admins only: an **Admins** section (promote/demote users)
  and a per-workspace **Access** editor (`allowedUserIds`). The client reads an
  `isAdmin` flag (from `/api/system/admins` or root-status) to gate this UI.
- `wiki-slugs-store`, `editor-store`, `tree-store`: any cached state that is
  keyed by path must also be reset on workspace switch (cheap: remount the
  page subtree on `ws` change via a React `key={activeWorkspaceId}`).

### 9. CLI / startup (`bin/wiki-viewer.js`, `ROOT_DIR`)

- `ROOT_DIR` (and `wiki-viewer ~/dir`) still works: on boot, if no workspaces
  exist, auto-create one from `ROOT_DIR` and mark it default/lastOpened. So the
  zero-config single-dir path is unchanged for existing users.
- README "switch the served directory" copy updates to mention multiple
  concurrent workspaces.

## Isolation guarantees (the "no bleed" contract)

| Surface              | Before            | After                           |
| -------------------- | ----------------- | ------------------------------- |
| Root dir             | one global        | per request, from `ws`          |
| Sidecars / activity  | `<root>/.proof/`  | unchanged (already per-root)    |
| Edit leases          | key=relPath       | key=`wsId\0relPath`             |
| In-proc + file locks | key=relPath       | key=`wsId\0relPath`             |
| Idempotency LRU      | key=idemKey       | key=`wsId\0idemKey`             |
| Audit DB             | path only         | `+ workspace_id` column         |
| Agents               | global path globs | `+ workspaceId` grant, enforced |
| Access control       | any signed-in     | admin-set `allowedUserIds`/ws   |

Two workspaces sharing the same relative path (`notes.md`) can be edited
simultaneously without lock contention, lease confusion, or idempotency
cross-talk.

## Testing

Extend `src/tests/proof/*`:

- Two-workspace lease test: lease on `(wsA, x.md)` does not make
  `(wsB, x.md)` active.
- Mutex/lock test: concurrent writes to same relPath in two workspaces do not
  serialize against each other (or at least do not corrupt).
- Idempotency: same key in two workspaces are independent.
- Scope test: agent granted `wsA` is 403 on `X-Workspace: wsB`.
- Access test: user not in `allowedUserIds` is 403; admin always passes.
- Admin test: non-admin POST /workspaces is 403; last-admin DELETE refused;
  first-signup bootstrap promotes one admin.
- Migration test: old config.json (lastOpenedPath + pinnedPaths) yields one
  workspace; old agents.json backfills workspaceId.
- Update existing tests: `setRootDir(tmpRoot)` calls in test setup become
  "create a workspace + resolve it" (helper).

## Rollout / sequencing

0. Admin role: `auth/admin.ts`, `/api/system/admins`, bootstrap, settings UI
   section. Independent, shippable alone.
1. `workspaces.ts` + `workspace-context.ts` + config migration (no route
   changes yet; default workspace mirrors old behavior).
2. Namespacing stores (lease, mutex, file-lock, idempotency) with `wsId` arg,
   defaulting to the single default workspace so nothing breaks.
3. Thread `ctx.rootDir` through all 29 routes; delete `getRootDir` global.
4. Agent workspace scoping + audit column.
5. Workspace management API + client switcher + DirPicker repoint.
6. Tests, README, CLI copy.

Steps 1-2 are non-breaking and shippable alone. Step 3 is the big mechanical
diff (good candidate for a `worker` pass with explicit outcomes per route).

## Open questions / risks

- **`pnpm-workspace.yaml` naming clash**: this repo is itself a pnpm workspace.
  Use "workspace" in UI/API, but consider an internal code name like `space` or
  keep `workspace` and just be careful in docs. Low risk, naming only.
- **SSE watcher fan-out**: one chokidar watcher per (connection, workspace).
  Many open tabs on the same workspace = many watchers. Acceptable now;
  optimize later with a shared per-workspace watcher + ref count if needed.
- **Admin bootstrap timing**: writing the first user into `adminUserIds` must
  happen exactly once. Better-auth has no built-in "first user" hook, so
  either tap the signup callback or do it lazily on the first authenticated
  request when the admin set is empty (race-safe behind the config write
  mutex). Decide during step 0.
- **`allowedUserIds` default**: empty = any signed-in user (matches today's
  behavior). Admins tighten per workspace via the Access editor.
- Removing a workspace leaves `.proof/` and `.locks/` sentinels on disk; fine
  (directory untouched by design), but document it.
