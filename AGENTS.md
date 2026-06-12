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

## Commands

```bash
pnpm install
ROOT_DIR=~/notes pnpm dev      # dev server, hot reload
pnpm dev:https                 # dev with experimental HTTPS
pnpm build                     # production build (standalone)
pnpm test                      # proof + auth suite (tsx node:test, 40 files / 180+ tests)
```

Test runner: `tsx --import ./src/tests/proof/preload.ts --test src/tests/proof/*.test.ts`.
Single file: `tsx --import ./src/tests/proof/preload.ts --test src/tests/proof/<name>.test.ts`.

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
  editor/              TipTap editor, proof-span, comment-pip, suggestion-card
  ai-panel/            Agents, activity, install panel
  wiki/ layout/ search/ ui/ auth-settings-sheet.tsx dir-picker.tsx
src/lib/
  proof/               Agent protocol core: ops-applier, registry, file-lock, raw-fs,
                       collab-state, sidecar, blocks, block-refs, idempotency, rate-limit,
                       audit, lease, mutex, activity, event-bus, pending, glob
  auth/                Better Auth server+client, allowlist, CSRF
  git.ts git-secrets.ts  System-git wrapper (provider-agnostic; token via GIT_ASKPASS),
                       secret scanning. Backs git-history/diff/branch + read-only repo workspaces.
  shared-docs/         Public shared-doc link store (db.ts)
  workspaces.ts        Workspace registry (multi-root)
  config.ts root-dir.ts app-runner.ts markdown/ search/ cabinets/ embeds/ google/
src/stores/            Zustand stores
src/middleware.ts      Cookie-presence gate for UI routes
packages/wiki-viewer-mcp/   Standalone MCP adapter (own package.json, npm-published)
docs/                  agent-collab-plan.md (tier-2 spec), file-vs-collab-authority.md
agents/                Installable Agent Skill + bootstrap prompt
```

Import alias: `@/*` → `./src/*`.

## Agent API model (the core domain)

Two tiers share one auth/scope/lock spine:

- **Tier 1 — raw filesystem** (`/api/agent/fs/*`): read/write/edit/list/search/move/delete for
  all file types. Byte-accurate, audited. Overwrite requires `If-Match: <sha256>`.
- **Tier 2 — Markdown collab** (`/api/agent/files/*`): block-ops wrapped in `<proof-span>`
  provenance marks, comments, suggestions. Revision-checked, idempotent.

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
