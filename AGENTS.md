# AGENTS.md

Context for AI agents working in the **wiki-viewer** codebase.

## What this is

Local-or-remote file browser + editor. Run from terminal, starts a Next.js web server,
navigate/read/edit any directory. Single-user no-auth by default; multi-user auth turns on
once anyone signs up. Exposes an HTTP API for AI agents (two tiers) plus an MCP adapter.
Git-aware: detects repos, shows branch/history/diff, supports git-backed read-only workspaces.
Public shared-doc links via `/api/share`.

Published to npm as `wiki-viewer`. CLI entry: `bin/wiki-viewer.js`.

## Stack

- **Next.js 16** (App Router, standalone output) + **React 19** + **TypeScript**
- **Tailwind 3** + Radix UI + shadcn-style components (`src/components/ui`)
- **TipTap 3** rich Markdown editor
- **Better Auth** + **better-sqlite3** + **kysely** (pinned `0.28.5`) for auth/sessions
- **Zustand** for client state (`src/stores`)
- **chokidar** file watching, **proper-lockfile** write locks
- Package manager: **pnpm** (workspace; do not use npm/yarn for installs)
- Node engines: `>=20.9.0`; pnpm workspace includes this package and `packages/wiki-viewer-mcp`
  in a single root lockfile.

## Security model

- **Authentication.** UI routes require a valid Better Auth session. The agent API uses
  per-agent bearer tokens (`Authorization`) plus `X-Agent-Id` / `X-Workspace`. Public share
  links use opaque tokens only.
- **CSRF.** All state-changing `/api/wiki/*` and `/api/system/*` routes check the `Origin`
  header against `WIKI_OWNER_HOSTS`. Cross-origin requests carrying a session cookie are
  rejected `403 FORBIDDEN`.
- **Path containment.** The only filesystem boundary primitive is `resolveWorkspacePath()`
  in `src/lib/fs/workspace-path.ts`. It realpaths the workspace root, rejects absolute paths,
  `..` segments, and denied segments (e.g. `.proof`, `.git`), and climbs to the nearest real
  ancestor for missing create targets so symlink/missing-descendant escapes cannot cross
  workspace roots.
- **Browser file routes.** `/api/assets/*`, `/api/upload/*`, and all `/api/wiki/*` file routes
  resolve a user/API-key workspace context before touching disk; unauthenticated reads and
  writes return `401`.
- **App runner.** Launching a node app executes host code. In authenticated mode only admins
  may start/stop apps. `WIKI_NO_AUTH=1` restores local single-user behavior; set
  `WIKI_ALLOW_APP_RUNNER=1` to explicitly allow non-admins to launch apps in their workspaces.
  Apps are keyed by `{workspaceId, relPath}` and the proxy requires workspace access before
  forwarding to the child process.
- **Protected shares.** Unlocking a password-protected share sets a short-lived, scoped,
  `HttpOnly` cookie derived from the stored password hash (via HMAC). The password is never
  accepted or logged in the URL.
- **HTML previews.** Shared HTML and local HTML previews are sandboxed without combining
  `allow-scripts` with `allow-same-origin`. Trusted executable apps belong in the privileged
  node-app runner, not in arbitrary HTML previews.
- **No process-global root.** The process-global `root-dir` module, the legacy
  root-mutation routes, and the lexical path guard were removed. `ROOT_DIR` and
  legacy `lastOpenedPath` still seed a real workspace on startup, but no live route
  mutates a global root.

## Commands

```bash
pnpm install
pnpm dev                       # dev server, hot reload
pnpm dev:https                 # dev with experimental HTTPS
pnpm build                     # production build (standalone)
pnpm test                      # proof + auth suite (test floor: 636 tests)
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # biome check
pnpm format:check              # format consistency check
```

Test runner: `scripts/test-floor.mjs` runs `src/tests/proof/*.test.ts` via `tsx`, fails if the
pass count drops below `.test-floor` (624), and only writes `.test-floor` when passed
`--update-floor`.

## Layout

```
bin/wiki-viewer.js     CLI: arg parse, config, HTTPS proxy, systemd/launchd service, init wizard
src/app/
  api/agent/           Agent HTTP API — fs (tier1), files/events/sidecar (tier2),
                       activity, register, admin, internal, settings
  api/agents/          Public install/skill discovery endpoints
  api/auth/            Better Auth handler
  api/wiki/            File browser API (session-gated)
  api/system/          System config API (session-gated)
  api/share/           Public shared-doc links (token-gated)
  api/owner/ api/upload/ api/assets/ api/app-proxy/
  signin/  layout.tsx  page.tsx  manifest.ts
src/components/
  editor/              TipTap editor, activity provenance, comment-pip, suggestion-card
  ai-panel/            Agents, activity, install panel
  wiki/ layout/ search/ ui/ auth-settings-sheet.tsx dir-picker.tsx
src/lib/
  proof/               Agent protocol core: ops-applier, registry, file-lock, raw-fs,
                       collab-state, sidecar, blocks, block-refs, idempotency, rate-limit,
                       audit, lease, mutex, activity, event-bus, pending, glob
  auth/                Better Auth server+client, allowlist, CSRF
  git.ts git-secrets.ts  System-git wrapper (provider-agnostic; token via GIT_ASKPASS),
                       secret scanning. Backs git-history/diff/branch + read-only repo workspaces.
  shared-docs/         Public shared-doc link store (db.ts) + cookie-based unlock grant
  workspaces.ts        Workspace registry (multi-root)
  workspace-context.ts Per-request workspace resolution (browser + agent)
  fs/workspace-path.ts Canonical path containment (`resolveWorkspacePath`)
  config.ts app-runner.ts markdown/ search/ cabinets/ embeds/
src/stores/            Zustand stores
src/hooks/             Page-shell controllers (file tree, workspaces, open file)
src/components/wiki/   Extracted wiki-shell components
src/middleware.ts      Cookie-presence gate for UI routes; API auth delegated to handlers
packages/wiki-viewer-mcp/   Standalone MCP adapter (pnpm workspace package, npm-published)
docs/                  ux-contracts.md (user-facing behavior inventory), agent-collab-plan.md
                       (tier-2 spec), agent-fs-plan.md (tier-1 spec),
                       file-vs-collab-authority.md; docs/archive/ for completed plans
agents/                Installable Agent Skill + bootstrap prompt
```

Import alias: `@/*` → `./src/*`.

## UX Contracts

`docs/ux-contracts.md` is the canonical, ground-truth inventory of every user-facing
feature, trigger, edge case, exact constant, and keyboard shortcut in the app. It
has a Table of Contents for fast routing.

- **Always read the relevant section(s) before implementing anything user-facing.**
- **Always update the doc after implementing**, in the same change, not later.
- If code and the doc disagree, code is ground truth — fix the doc as part of the change.
- Read the file in full before editing; never rewrite it from a possibly-truncated
  read. Edit via targeted string replacement or chunked reads (offset/limit).

## Agent API model (the core domain)

Two tiers share one auth/scope/lock spine:

- **Tier 1 — raw filesystem** (`/api/agent/fs/*`): read/write/edit/list/search/move/delete for
  all file types. Byte-accurate, audited. Overwrite requires `If-Match: <sha256>`.
- **Tier 2 — Markdown collab** (`/api/agent/files/*`): block-ops with revision checks,
  idempotency, comments, suggestions, and activity-log provenance. Clean markdown.

**Working-vs-collaborating safety**: before editing a `.md` file, agents check the
`X-Collab-State` response header (`active` / `tracked` / `untracked` / `not-markdown`).
When `active` (human has it open), raw writes are rejected `409 COLLAB_ACTIVE` — use tier-2.
This is enforced inside the write lock, not advisory. See `docs/file-vs-collab-authority.md`.

**Auth**: Trust On First Use. Agent registers → owner approves in UI → one-shot token pickup.
Bearer token + `X-Agent-Id` on every request. Only SHA-256 token hashes stored
(`~/.wiki-viewer/agents.json`). Scopes: `paths` (glob), `ops` (`read`/`mutate`/`delete`).

**Workspaces**: one server serves many root dirs, isolated. Agents target via `X-Workspace: <id>`
header or `?ws=`. State (leases, locks, idempotency, sidecars, audit) namespaced per workspace.

## State / runtime

- User data dir: `~/.wiki-viewer/` — `auth.db` (WAL), `auth.secret` (0600), `agents.json`, `config.json`.
- SQLite WAL is single-host only (not NFS / not clustered).
- Config precedence: shell env > `config.json` `env` block > CLI-derived defaults.

## Conventions / gotchas

- Use pnpm. `kysely` is pinned to `0.28.5` via overrides — do not bump.
- All state-changing `/api/wiki/*` and `/api/system/*` routes do CSRF Origin checks against
  an allowlist (`WIKI_OWNER_HOSTS`). Cross-origin + cookie → `403`.
- Production refuses to boot unless `BETTER_AUTH_URL` is an `https://` origin
  (bypass with `WIKI_ALLOW_INSECURE=1` for dev/CI only).
- Editor saves send `baseRevision`; stale → `409 STALE_REVISION`, editor reloads.
- Agent paths reject traversal, symlink escape, and anything under `.proof/`.
- When adding agent-API behavior, add/extend tests in `src/tests/proof/` and run `pnpm test`.
- `AGENT_BEARER_TOKEN` (legacy single-secret) is dead — does nothing.
- Git access uses the system `git` binary; tokens injected via `GIT_ASKPASS`, never in
  process args / `.git/config` / `ps` output. `git-secrets.ts` scans for leaked secrets.
