<div align="center">
  <img src="public/logo.svg" width="80" height="80" alt="wiki-viewer logo" />
  <h1>wiki-viewer</h1>
  <p><strong>Browse, read, and edit your local files from a clean web UI. Now with multi-user auth and an HTTP API for AI agents.</strong></p>
  <p>
    Markdown · PDF · Office docs · Notebooks · Images · Code · and more
  </p>

  <p>
    <a href="https://www.npmjs.com/package/wiki-viewer"><img src="https://img.shields.io/npm/v/wiki-viewer" alt="npm version" /></a>
    <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js ≥18" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  </p>
</div>

---

## What is it?

**wiki-viewer** is a local-or-remote file browser and editor you run from your terminal. It starts a small web server and lets you navigate, read, and edit any directory on your machine.

Originally a zero-config single-user tool, it now supports:

- Multi-user sign-in (Google OAuth or email + password) for teams of 3 to 10 sharing a VPS.
- An HTTP collaboration API that lets AI agents read and edit Markdown files alongside you, with provenance marks, comments, suggestions, and revision-checked mutations.
- Per-agent registration and scoped tokens. No shared bearer secret.

Single-user, no-auth mode still works. Auth turns on automatically once anyone signs up.

---

## Features

| Category         | What's included                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File viewers** | Markdown (with frontmatter), PDF, images (PNG / JPG / SVG / WebP), video & audio, CSV (table view), source code (syntax highlighting), DOCX, XLSX, PPTX, Jupyter notebooks, Mermaid diagrams, HTML |
| **Editor**       | Rich TipTap editor for Markdown files                                                                                                                                                              |
| **File ops**     | Upload files, create folders, delete, drag-to-move                                                                                                                                                 |
| **Wiki links**   | `[[page-name]]` links between Markdown files                                                                                                                                                       |
| **Dark mode**    | System-aware, with manual toggle                                                                                                                                                                   |
| **Auth**         | Google OAuth and email + password via [Better Auth](https://better-auth.com). Email allowlist. SQLite-backed sessions.                                                                             |
| **AI agents**    | Per-agent HTTP API. Trust On First Use registration. Comments, suggestions, inline provenance marks (`<proof-span>`). Block-level revision check. Idempotency keys. Per-IP rate limiting.          |
| **HTTPS**        | Required for remote access. Self-signed cert (OpenSSL), trusted local cert (mkcert), or your own TLS in front of plain HTTP.                                                                       |

---

## Quick start

```bash
# Point it at a directory
npx wiki-viewer ~/notes

# No directory? Pick one in the browser
npx wiki-viewer

# Running on a remote machine? HTTPS is required (see note below)
npx wiki-viewer ~/notes --https
```

Open **http://localhost:3000** (or **https://localhost:3000** with `--https`).

On first run with no users in the database, the app works in single-user mode and any visitor on `localhost` can sign up. Set `AUTH_ALLOWED_DOMAIN` or `AUTH_ALLOWED_EMAILS` before exposing the server to anyone else.

> ⚠️ **Running on a remote host?** The app must be accessed over **HTTPS**. Browsers gate several APIs (service workers, PDF.js, secure-context features) behind HTTPS. Plain HTTP only works on `localhost`.

### CLI options

```
wiki-viewer [directory] [options]

  directory            Directory to serve  (optional — pick in the browser if omitted)

Options:
  -p, --port <port>   Port to listen on   (default: 3000)
  -H, --host <host>   Host to bind to     (default: localhost)
      --https         Enable HTTPS        (self-signed cert, required on remote)
  -h, --help          Show this help message
```

Examples:

```bash
# Custom port
npx wiki-viewer ~/notes -p 8080

# Bind to all interfaces (accessible on your local network)
npx wiki-viewer ~/notes -H 0.0.0.0

# HTTPS on a custom port
npx wiki-viewer ~/notes --https -p 8443
```

---

## Auth and multi-user mode

wiki-viewer uses [Better Auth](https://better-auth.com) with SQLite. State lives at `~/.wiki-viewer/auth.db` (WAL mode) and `~/.wiki-viewer/auth.secret` (chmod 0600). Both are created on first start. Set `BETTER_AUTH_SECRET` in the environment to override the file-stored secret.

Sign-in providers:

- **Google OAuth.** Enabled when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- **Email + password.** Always available. No verification email is sent by default.

### Email allowlist

By default any email can sign up. Lock it down before exposing the server.

There are two ways to set the allowlist. The settings sheet is the easy path; env vars are the fallback for headless or scripted deploys.

**From the UI (recommended).** Click the gear icon in the sidebar toolbar to open Signup allowlist. Enter allowed emails and domains, one per line or comma-separated, then save. Changes are stored in `~/.wiki-viewer/config.json` and apply on the next signup with no restart. Clearing both lists reverts to the environment variables below.

**From the environment.** Set either or both before starting the server:

```bash
# Allow specific accounts
export AUTH_ALLOWED_EMAILS="alice@team.com,bob@team.com"

# Or whole domains (csv)
export AUTH_ALLOWED_DOMAIN="team.com,partner.org"
```

**Precedence.** If the UI allowlist in `config.json` is non-empty, it wins and the env vars are ignored. If it is empty, the env vars are used. If neither is set, any email can sign up. When both an email and a domain list apply, either match grants access.

### Production guard

In production, the server refuses to boot unless `BETTER_AUTH_URL` is set to an `https://` origin. This prevents accidentally serving auth cookies over plain HTTP.

```bash
export BETTER_AUTH_URL="https://wiki.team.com"
```

For development or local smoke tests, set `WIKI_ALLOW_INSECURE=1` to bypass the guard.

### CSRF and trusted origins

All state-changing routes (`POST` / `PUT` / `DELETE` / `PATCH`) under `/api/wiki/*` and `/api/system/*` check the request's `Origin` header against an allowlist. Cross-origin requests with a session cookie are rejected with `403 FORBIDDEN`.

By default the allowlist includes `localhost` and `127.0.0.1`. Add hostnames you actually browse from:

```bash
export WIKI_OWNER_HOSTS="wiki.team.com,office.lan"
```

Do not place wiki-viewer behind a reverse proxy that rewrites `Host`. The Origin check assumes the browser-visible hostname matches what wiki-viewer sees. Bind to loopback and front with a TLS-terminating proxy that preserves the original `Host` (nginx `proxy_set_header Host $host;` or Caddy default).

### Rate limits

| Endpoint          | Default                   |
| ----------------- | ------------------------- |
| `/sign-in/email`  | 20 requests / 60 seconds  |
| `/sign-up/email`  | 10 requests / 60 seconds  |
| Other auth routes | 100 requests / 60 seconds |

Rate limiting is disabled in development (`NODE_ENV !== "production"`).

### Recovering a locked-out account

The rate limiter stores counts in memory. Restart the server to clear it.

To delete and re-create a user from scratch:

```bash
sqlite3 ~/.wiki-viewer/auth.db "DELETE FROM user WHERE email='you@team.com';"
sqlite3 ~/.wiki-viewer/auth.db "DELETE FROM account WHERE userId NOT IN (SELECT id FROM user);"
sqlite3 ~/.wiki-viewer/auth.db "DELETE FROM session WHERE userId NOT IN (SELECT id FROM user);"
```

Then sign up again.

### Editor save conflicts

The Markdown editor now sends a `baseRevision` with every save. If another user (or an agent) modified the file in the meantime, the server returns `409 STALE_REVISION` and the editor silently reloads the new content. Your in-progress edits in that tab are lost. Reload before making large changes if you know someone else is also editing.

---

## Working with AI agents

wiki-viewer exposes an HTTP collaboration protocol so agents (Claude, Cursor, ChatGPT desktop, custom scripts) can read and edit Markdown files. Every AI-authored insert is wrapped in an inline `<proof-span>` mark so the human reviewer can see, accept, or revert each change.

The protocol is intentionally API-compatible in spirit with [Proof SDK](https://github.com/EveryInc/proof-sdk).

### Trust On First Use registration

Each agent gets its own bearer token tied to a stable identity. No shared secret.

1. Agent calls `POST /api/agent/register` with `id`, `displayName`, and requested `scope`.
2. Server returns `registrationId` and `pollUrl`. The id itself is the pickup secret.
3. Owner opens the AI Panel, sees the pending request, clicks **Approve**.
4. Agent polls and receives a one-shot `token`. Pickup deletes the token from the server.
5. Agent sends `Authorization: Bearer <token>` and `X-Agent-Id: <id>` on every later request.

The registry lives in `~/.wiki-viewer/agents.json`. Only SHA-256 hashes of tokens are stored.

### Distribute the agent skill

The running server exposes itself as an installable [Agent Skill](https://github.com/anthropics/skills):

```bash
# Claude Code, Codex, Cursor, OpenCode
npx skills add anh-chu/wiki-viewer/agents/wiki-viewer-skill
```

For any chat agent, paste the bootstrap prompt from `<your-server>/agents/install` (also visible in the AI Panel). The agent fetches `/api/agents/install` and learns the full op vocabulary at runtime.

### Op vocabulary

Block-level edits (revision-checked, idempotent):

```json
{ "type": "block.replace",      "ref": "b7f2c1", "markdown": "New content." }
{ "type": "block.insertAfter",  "ref": "b7f2c1", "markdown": "..." }
{ "type": "block.insertBefore", "ref": "b7f2c1", "markdown": "..." }
{ "type": "block.delete",       "ref": "b7f2c1" }
{ "type": "block.append",       "markdown": "..." }
{ "type": "block.prepend",      "markdown": "..." }
```

Comments and suggestions:

```json
{ "type": "comment.add",     "ref": "b7f2c1", "text": "Why end of June?" }
{ "type": "comment.reply",   "commentId": "c4a1", "text": "API freeze." }
{ "type": "comment.resolve", "commentId": "c4a1" }
{ "type": "suggestion.add",  "ref": "b7f2c1", "kind": "replace", "markdown": "...",
                             "basis": "described", "basisDetail": "user asked" }
{ "type": "suggestion.accept", "suggestionId": "s3b2" }
```

See [`docs/agent-collab-plan.md`](docs/agent-collab-plan.md) for the full spec: snapshot shape, event log, suggestion lifecycle, provenance attribute rules, and edge cases.

### Key routes

Anonymous:

| Method | Path                          | Description                                     |
| ------ | ----------------------------- | ----------------------------------------------- |
| `POST` | `/api/agent/register`         | Request registration. Returns `registrationId`. |
| `GET`  | `/api/agent/register/<regId>` | Poll status. Returns token once approved.       |
| `GET`  | `/api/agents/install`         | Discovery JSON for agents.                      |
| `GET`  | `/api/agents/skill`           | Raw SKILL.md.                                   |
| `GET`  | `/api/agents/skill.tar.gz`    | Skill as gzip tarball.                          |

Owner-only (session cookie):

| Method | Path                                             | Description                 |
| ------ | ------------------------------------------------ | --------------------------- |
| `GET`  | `/api/agent/admin/registrations`                 | List pending registrations. |
| `POST` | `/api/agent/admin/registrations/<regId>/approve` | Approve, mint token.        |
| `POST` | `/api/agent/admin/registrations/<regId>/deny`    | Deny.                       |
| `GET`  | `/api/agent/admin/agents`                        | List your approved agents.  |
| `POST` | `/api/agent/admin/agents/<id>/revoke`            | Revoke an agent.            |

Agent routes (bearer + `X-Agent-Id`, scope-checked):

| Method | Path                                     | Required scope        |
| ------ | ---------------------------------------- | --------------------- |
| `GET`  | `/api/agent/files/<path.md>`             | `read` + path match   |
| `POST` | `/api/agent/files/<path.md>`             | `mutate` + path match |
| `GET`  | `/api/agent/events/<path.md>?after=<id>` | `read` + path match   |
| `POST` | `/api/agent/events/<path.md>`            | `read` + path match   |
| `GET`  | `/api/agent/sidecar/<path.md>`           | `read` + path match   |
| `GET`  | `/api/agent/settings`                    | `read`                |
| `GET`  | `/api/agent/activity`                    | `read`                |

### Full curl trace

```bash
# 1. Agent registers
curl -s -X POST https://wiki.team.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"id":"ai:claude","displayName":"Claude",
       "scope":{"paths":["**/*"],"ops":["read","mutate"]}}'
# -> { "registrationId":"reg_abc","pollUrl":"/api/agent/register/reg_abc","status":"pending" }

# 2. Owner approves in the AI Panel.

# 3. Agent picks up the token (one shot, 410 on replay)
TOKEN=$(curl -s https://wiki.team.com/api/agent/register/reg_abc | jq -r .token)

# 4. Read a file
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Agent-Id: ai:claude" \
  https://wiki.team.com/api/agent/files/notes.md | jq

# 5. Mutate. `by` must equal `X-Agent-Id`. Idempotency-Key is required.
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Agent-Id: ai:claude" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: req-$(cat /proc/sys/kernel/random/uuid)" \
  -d '{"baseRevision":7,"by":"ai:claude",
       "ops":[{"type":"block.append","markdown":"From your agent."}]}' \
  https://wiki.team.com/api/agent/files/notes.md

# 6. Poll events to see human comments, suggestion accepts, external edits
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  "https://wiki.team.com/api/agent/events/notes.md?after=0" | jq
```

Response codes to handle:

- `401 UNAUTHORIZED` — bad token or `X-Agent-Id`.
- `403 FORBIDDEN` — out of scope or `by` mismatches identity.
- `409 STALE_REVISION` — refetch and retry. Response includes a fresh snapshot.
- `409 BLOCK_NOT_FOUND` — the ref no longer exists.
- `409 IDEMPOTENCY_KEY_REUSED` — same key, different body.
- `429 RATE_LIMITED` — honor `Retry-After`. Default 60 ops/minute per agent.

### Agent rate limit override

```bash
export AGENT_RATE_LIMIT=120
```

Note: `AGENT_BEARER_TOKEN` (legacy single-secret mode) does nothing now. The server logs a one-time warning if it is set. Remove it.

---

## Dev setup

### Prerequisites

- **Node.js** ≥ 18
- **pnpm** — `npm install -g pnpm`

### Run from source

```bash
git clone https://github.com/anh-chu/wiki-viewer.git
cd wiki-viewer
pnpm install
ROOT_DIR=~/notes pnpm dev
```

The dev server supports hot reload.

### Scripts

| Command          | Description                            |
| ---------------- | -------------------------------------- |
| `pnpm dev`       | Next.js development server             |
| `pnpm dev:https` | Dev server with experimental HTTPS     |
| `pnpm build`     | Production build                       |
| `pnpm start`     | Production server (after `build`)      |
| `pnpm wiki`      | CLI entry point (after `build`)        |
| `pnpm test`      | Run the proof + auth test suite (180+) |

### All environment variables

| Variable               | Description                                                | Default               |
| ---------------------- | ---------------------------------------------------------- | --------------------- |
| `ROOT_DIR`             | Directory to serve                                         | `~/wiki-viewer-files` |
| `PORT`                 | Port to listen on                                          | `3000`                |
| `HOSTNAME`             | Host / interface to bind                                   | `localhost`           |
| `BETTER_AUTH_URL`      | Public origin (required in production, must be `https://`) | unset                 |
| `BETTER_AUTH_SECRET`   | Override for the auto-generated session signing secret     | file-stored           |
| `GOOGLE_CLIENT_ID`     | Enable Google OAuth button                                 | unset                 |
| `GOOGLE_CLIENT_SECRET` | Enable Google OAuth button                                 | unset                 |
| `AUTH_ALLOWED_EMAILS`  | csv: only these emails can sign up (overridden by UI allowlist if set) | unset (open) |
| `AUTH_ALLOWED_DOMAIN`  | csv: only emails on these domains can sign up (overridden by UI allowlist if set) | unset (open) |
| `WIKI_OWNER_HOSTS`     | csv: extra hostnames trusted for CSRF Origin check         | `localhost,127.0.0.1` |
| `WIKI_ALLOW_INSECURE`  | Set to `1` to bypass the prod-https guard (dev / CI only)  | unset                 |
| `AGENT_RATE_LIMIT`     | Max mutation ops per minute per agent identity             | `60`                  |

---

## Self-hosted deployment

### Option A — Build and run directly

```bash
git clone https://github.com/anh-chu/wiki-viewer.git
cd wiki-viewer
pnpm install
pnpm build

# Static assets into the standalone output
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# Start
ROOT_DIR=/srv/notes BETTER_AUTH_URL=https://wiki.team.com \
  AUTH_ALLOWED_DOMAIN=team.com \
  node .next/standalone/server.js
```

Or use the CLI wrapper, which handles the static-asset copy:

```bash
node bin/wiki-viewer.js /srv/notes
```

### Option B — PM2

```bash
npm install -g pm2

pm2 start bin/wiki-viewer.js \
  --name wiki-viewer \
  -- /srv/notes --port 3000

pm2 save
pm2 startup    # follow printed instructions
```

### Option C — systemd

`/etc/systemd/system/wiki-viewer.service`:

```ini
[Unit]
Description=wiki-viewer
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/wiki-viewer
ExecStart=/usr/bin/node bin/wiki-viewer.js /srv/notes --port 3000 --host 0.0.0.0
Restart=on-failure
Environment=NODE_ENV=production
Environment=BETTER_AUTH_URL=https://wiki.team.com
Environment=AUTH_ALLOWED_DOMAIN=team.com
Environment=WIKI_OWNER_HOSTS=wiki.team.com

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable wiki-viewer
sudo systemctl start wiki-viewer
sudo journalctl -u wiki-viewer -f
```

### HTTPS

`--https` runs an HTTPS reverse proxy in front of the internal HTTP server. mkcert is used when available, otherwise OpenSSL self-signed.

For real deployments, run wiki-viewer on plain HTTP behind nginx or Caddy with a Let's Encrypt cert. Configure the proxy to:

- Terminate TLS.
- Preserve the original `Host` header (`proxy_set_header Host $host;` in nginx; Caddy does this by default).
- Forward all paths.

### Production deployment checklist

- [ ] `BETTER_AUTH_URL=https://your-domain` exported in the service environment.
- [ ] `AUTH_ALLOWED_DOMAIN` or `AUTH_ALLOWED_EMAILS` set before opening the server to anyone.
- [ ] `WIKI_OWNER_HOSTS` includes every hostname your users browse from.
- [ ] TLS handled by your reverse proxy or `--https`. Plain HTTP rejects in prod.
- [ ] `~/.wiki-viewer/` on local disk only. SQLite WAL is not safe on NFS or shared between replicas.
- [ ] Single host. If you cluster, you also need a shared lock service. Out of scope today.
- [ ] OAuth redirect URI registered with Google: `https://your-domain/api/auth/callback/google`.
- [ ] If you ran an older version: legacy agents in `agents.json` without `ownerUserId` are visible to and revocable by any signed-in user. Either edit the file to add `"ownerUserId": "<your user id>"` to each, or revoke and re-register them.

---

## Project structure

```
wiki-viewer/
├── agents/                       Installable Agent Skill + bootstrap prompt
│   ├── wiki-viewer-skill/        SKILL.md and assets
│   └── bootstrap-prompt.md       One-paragraph prompt for any chat agent
├── bin/
│   └── wiki-viewer.js            CLI entry point
├── docs/
│   ├── agent-collab-plan.md      Full v1 spec for the agent HTTP protocol
│   └── agent-collab-v2-plan.md   Reference for a future Yjs / multi-tenant pivot
├── src/
│   ├── app/
│   │   ├── api/agent/            Agent HTTP API
│   │   ├── api/agents/           Public install endpoints
│   │   ├── api/auth/             Better Auth handler
│   │   ├── api/wiki/             File browser API (session-gated)
│   │   ├── api/system/           System config API (session-gated)
│   │   └── signin/               Sign-in page
│   ├── components/
│   │   ├── editor/               TipTap editor + proof-span + comment-pip + suggestion-card
│   │   └── ai-panel/             Right-side AI panel (agents, activity, install)
│   ├── lib/
│   │   ├── auth/                 Better Auth server + client + allowlist + CSRF
│   │   └── proof/                Agent protocol core (ops-applier, registry, file-lock)
│   ├── stores/                   Zustand state
│   ├── tests/proof/              Node test runner suite (180+ tests)
│   └── middleware.ts             Cookie-presence gate for UI routes
├── public/
├── next.config.ts
└── package.json
```

---

## Contributing

1. Fork and branch: `git checkout -b my-feature`
2. `pnpm install && pnpm dev`
3. Run tests: `pnpm test`
4. Open a PR.

Bug reports and feature requests welcome via [GitHub Issues](https://github.com/anh-chu/wiki-viewer/issues).

---

## License

MIT © [anh-chu](https://github.com/anh-chu)
