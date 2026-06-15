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
- An HTTP API for AI agents with **two tiers**: a raw filesystem (read/write/edit/list/search/move/delete for **all file types**) for fast filework, and a Markdown collaboration layer with provenance marks, comments, suggestions, and revision-checked mutations.
- A **working-vs-collaborating** safety model: when you have a Markdown doc open, agents automatically defer to the reviewable collab path instead of overwriting it.
- Per-agent registration and scoped tokens. No shared bearer secret.
- An optional `npx wiki-viewer-mcp` adapter so MCP-capable agents (Claude Code, Cursor, Codex) get native file tools against a remote instance.
- Full-text search (FTS5), public share links with optional password and expiry, git-backed read-only workspaces with history and diffs, and a Launch button to run any `package.json` app in place.

Single-user, no-auth mode still works. Auth turns on automatically once anyone signs up.

---

## Features

| Category         | What's included                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **File viewers** | Markdown (with frontmatter), PDF, images (PNG / JPG / SVG / WebP), video & audio, CSV (table view), source code (syntax highlighting), DOCX, XLSX, PPTX, Jupyter notebooks, Mermaid diagrams, HTML                                                                                                     |
| **Editor**       | Rich TipTap editor for Markdown files, with an exit-edit toggle to flip between read and edit modes                                                                                                                                                                                                    |
| **File ops**     | Upload files, create folders, delete, drag-to-move                                                                                                                                                                                                                                                     |
| **Search**       | Full-text search across the whole workspace, backed by SQLite FTS5 (BM25 ranking). Incremental indexing via file watcher. App and `.git` contents skipped.                                                                                                                                             |
| **Sharing**      | Generate public, read-only share links for any file. Optional password protection and expiry date. View counts tracked.                                                                                                                                                                                |
| **Node apps**    | A directory with a `package.json` becomes runnable: a Launch button starts any npm script (or the default), proxied through the viewer with live status and logs.                                                                                                                                      |
| **Git repos**    | Add a remote git repo (GitHub, GitLab, Bitbucket, Gitea, GHE) as a read-only workspace. Clones on the server, browse with the full viewer, refresh on demand. Private repos via access token. Per-file commit history, diffs, last-commit metadata, and a branch switcher for git-backed content.      |
| **Remote (SSH)** | Mount a remote directory over SSH (sshfs) as a workspace — **no local clone**. Browse, view, edit, search, upload, and the agent API all work live against the remote files. Auth via ssh-agent, key file, or password. Optional read-only mount. Requires `sshfs` + FUSE on the server (Linux/macOS). |
| **Wiki links**   | `[[page-name]]` links between Markdown files                                                                                                                                                                                                                                                           |
| **Layout**       | Resizable sidebar (persisted), content width (narrow / normal / wide) and alignment (center / left), selectable Editorial reading skin. Mobile-responsive.                                                                                                                                             |
| **PWA**          | Web app manifest, Apple meta tags, home-screen icons. Installable to the home screen.                                                                                                                                                                                                                  |
| **Dark mode**    | System-aware, with manual toggle                                                                                                                                                                                                                                                                       |
| **Auth**         | Google OAuth and email + password via [Better Auth](https://better-auth.com). Email allowlist. SQLite-backed sessions.                                                                                                                                                                                 |
| **AI agents**    | Per-agent HTTP API. Trust On First Use registration. Comments, suggestions, inline provenance marks (`<proof-span>`). Block-level revision check. Idempotency keys. Per-IP rate limiting.                                                                                                              |
| **HTTPS**        | Required for remote access. Self-signed cert (OpenSSL), trusted local cert (mkcert), or your own TLS in front of plain HTTP.                                                                                                                                                                           |

---

## Quick start

```bash
# Guided setup: directory, host/port, HTTPS, app settings, and optional
# install as a reboot-persistent service. Recommended for first run.
npx wiki-viewer init

# Or run directly. Point it at a directory
npx wiki-viewer ~/notes

# No directory? Pick one in the browser
npx wiki-viewer

# Running on a remote machine? HTTPS is required (see note below)
npx wiki-viewer ~/notes --https

# Serve a remote directory over SSH — mounted live, no local clone
npx wiki-viewer me@server:/srv/docs
```

The wizard walks you through every option and writes `~/.wiki-viewer/config.json`, so you do not have to remember flags. You can re-run it any time, or edit the config with `wiki-viewer config set`.

Open **http://localhost:3000** (or **https://localhost:3000** with `--https`).

To switch between directories later, use the **workspace switcher** at the bottom of the sidebar. Each _workspace_ is a registered root directory; you can run several at once with no state bleed (open different workspaces in different browser tabs). See [Workspaces](#workspaces) below. No restart needed.

On first run with no users in the database, the app works in single-user mode and any visitor on `localhost` can sign up. Set `AUTH_ALLOWED_DOMAIN` or `AUTH_ALLOWED_EMAILS` before exposing the server to anyone else.

> ⚠️ **Running on a remote host?** The app must be accessed over **HTTPS**. Browsers gate several APIs (service workers, PDF.js, secure-context features) behind HTTPS. Plain HTTP only works on `localhost`.

### CLI options

```
wiki-viewer [directory] [options]

  directory            Directory to serve  (optional — pick in the browser if omitted).
                       May also be an SSH target (user@host:/path) — mounted via
                       sshfs and served live, no local clone.

Options:
  -p, --port <port>   Port to listen on        (default: 3000)
  -H, --host <host>   Host to bind to          (default: localhost)
      --https         Enable HTTPS             (self-signed cert, required on remote)
      --no-auth       No sign-in, no session    (open to anyone on the network)
      --ssh-key <path>   Private key for the SSH target (default: ssh-agent / host keys)
      --ssh-port <port>  SSH port for the target        (default: 22)
      --ssh-password     Prompt for an SSH password (or set WIKI_SSH_PASSWORD)
      --ssh-readonly     Mount the SSH target read-only
  -v, --version       Print version
  -h, --help          Show this help message

Commands:
  service install [dir] [options]   Install as a user service (persists across reboot)
  service uninstall                 Remove the user service
  service status                    Show service status
  service logs                      Tail service logs
  service restart                   Restart the service
  update                            Update to the latest version and restart the service
```

Examples:

```bash
# Custom port
npx wiki-viewer ~/notes -p 8080

# Bind to all interfaces (accessible on your local network)
npx wiki-viewer ~/notes -H 0.0.0.0

# HTTPS on a custom port
npx wiki-viewer ~/notes --https -p 8443

# Remote directory over SSH (sshfs), using a specific key, mounted read-only
npx wiki-viewer me@server:/srv/docs --ssh-key ~/.ssh/id_ed25519 --ssh-readonly

# Remote over a non-standard SSH port, with a password (prompted)
npx wiki-viewer me@host:/data --ssh-port 2222 --ssh-password
```

### Run as a service (reboot persistence)

Install wiki-viewer as a user service so it starts at boot and restarts on failure. Linux uses `systemd --user`, macOS uses a launchd LaunchAgent. No root needed.

```bash
# Install with the run config you want (dir, host, port, https)
wiki-viewer service install ~/notes -H 0.0.0.0 -p 3003 --https

# Manage it
wiki-viewer service status
wiki-viewer service logs
wiki-viewer service restart
wiki-viewer service uninstall
```

The run config is saved to `~/.wiki-viewer/config.json`. Edit that file and run `wiki-viewer service restart` to change settings without reinstalling. To change the served directory at runtime, use the workspace switcher in the sidebar (see [Workspaces](#workspaces)).

On Linux, install enables lingering (`loginctl enable-linger`) so the service runs without an active login session and survives reboot. If that step needs privileges, the installer prints the command to run manually.

> Ad-hoc runs like `wiki-viewer ~/docs` ignore the saved bind (dir/host/port), but still read app env from `config.json`. Only the service (and `wiki-viewer service run`) reads the full config.

### App configuration (env)

App settings (OAuth keys, allowlists, rate limits) are env vars. You can keep them in the config file instead of exporting them, and the service will load them on every start.

```bash
# Set at install time
wiki-viewer service install ~/notes --env GOOGLE_CLIENT_ID=... --env GOOGLE_CLIENT_SECRET=...

# Or manage them later
wiki-viewer config set AUTH_ALLOWED_DOMAIN=example.com
wiki-viewer config set AGENT_RATE_LIMIT=120
wiki-viewer config unset AGENT_RATE_LIMIT
wiki-viewer config show
wiki-viewer service restart   # apply changes
```

These land in the `env` block of `config.json`:

```json
{
  "rootDir": "/home/you/notes",
  "host": "0.0.0.0",
  "port": "3003",
  "https": true,
  "env": {
    "GOOGLE_CLIENT_ID": "...",
    "AUTH_ALLOWED_DOMAIN": "example.com"
  }
}
```

**Precedence:** a variable exported in your shell always wins, then the `env` block in `config.json`, then values the CLI derives for you. So you can still override anything per run with `KEY=VALUE wiki-viewer ...` or `--env KEY=VALUE`.

**`BETTER_AUTH_URL` is derived automatically** from the host, port, and scheme you run with, so the common case needs no config. On `localhost` over HTTP the CLI also sets `WIKI_ALLOW_INSECURE=1` for you (browsers treat localhost as a secure context). If you serve plain HTTP on a non-local host the CLI prints a warning, because login cookies and service workers will not work there. Use `--https`, or terminate TLS in a proxy and set `BETTER_AUTH_URL` to its public `https://` URL via `config set` or your shell.

### Update

```bash
wiki-viewer update
```

Updates the global install to the latest version (npm/pnpm/yarn auto-detected) and restarts the service if one is installed.

---

## Workspaces

A **workspace** is a registered root directory. One running wiki-viewer can
serve many workspaces at once, fully isolated from each other:

- Two browser tabs can each open a different workspace (via a `?ws=<id>` URL
  param) and edit files concurrently. Edit leases, write locks, idempotency
  keys, collab sidecars, and the audit log are all namespaced per workspace —
  a `notes.md` in workspace A never collides with a `notes.md` in workspace B.
- AI agents target a workspace with an `X-Workspace: <id>` header (or `?ws=`).
  An agent's grant may be pinned to one workspace; requests that resolve to a
  different workspace are rejected `403 FORBIDDEN`. Agents registered without a
  workspace id keep working across all workspaces (wildcard).

### Switching and creating

The sidebar footer shows the active workspace. Click it to switch between the
workspaces you can access, or (admins only) **Add workspace…** to register a
new root directory. Switching navigates to `?ws=<id>` and resets the view.

The legacy single-directory flow is unchanged: launching with `ROOT_DIR` or
`wiki-viewer <dir>` auto-registers that directory as the first workspace, and a
single-workspace install behaves exactly as before (no `?ws=` needed).

### Git-backed workspaces (read-only)

Teams that keep docs in a git repo can browse them with the full viewer instead
of reading raw files on a host like GitHub. In the directory picker, switch to
**From Git**, paste a repository URL, and the server clones it into a managed
workspace under `~/.wiki-viewer/repos/<id>/`.

- **Read-only.** The clone is served for reading only. Every file-mutating route
  (editor saves, uploads, moves, deletes, and both agent API tiers) is rejected
  `403 WORKSPACE_READ_ONLY`. Edits belong upstream in git, not here.
- **Any git host.** Works with GitHub, GitLab, Bitbucket, Gitea, and self-hosted
  GitHub Enterprise. Only `https://` URLs are accepted by default.
- **Private repos.** Supply an access token (PAT). It is stored on the server in
  `~/.wiki-viewer/git-secrets.json` (chmod 0600), never written to `config.json`,
  never logged, and never returned by any API. Some hosts need a specific
  username (GitLab uses `oauth2`, Bitbucket uses your account username).
- **Refresh.** Git workspaces show a **Refresh** button in the switcher. It runs
  `git pull --ff-only` to pull the latest commit. Refresh is manual by design,
  so there is no background polling or webhook to configure.
- **Branch.** Leave the branch blank to track the default branch, or pin a
  specific one. Git-backed content shows a **branch switcher** in the UI to
  check out any branch on demand, plus a branch badge.
- **History and diffs.** For files inside a git repo (including sub-folder repos
  detected automatically), the viewer surfaces per-file commit history, the diff
  for each commit, and last-commit metadata (author, date, message).
- **Subdirectory.** If the docs live in a subfolder (for example `docs/`),
  set the optional **Subdirectory** field. The server does a blobless sparse
  checkout that fetches only that subtree, so a large repo with a small docs
  folder clones fast and uses little disk. The workspace then serves only that
  folder. Leave it blank to serve the whole repo.

Host policy is configurable in `config.json` under a `git` block: set
`git.allowedHosts` (a list) to restrict which hosts can be cloned, or
`git.allowInsecureHttp: true` to permit plain `http://` for a trusted internal
host. Both are optional; the default allows any `https://` host.

### Remote workspaces over SSH (no clone)

When the files live on another machine and you do **not** want a local copy,
mount them over SSH. In the directory picker switch to **Over SSH**, enter an
SSH target (`user@host:/abs/path`), pick an auth method, and the server mounts
the remote directory with [sshfs](https://github.com/libfuse/sshfs) under
`~/.wiki-viewer/mounts/<id>/`. From there it is just a path, so the **full**
viewer works against it — browse, view, edit, search, upload, move, delete, and
both agent API tiers — with no clone and no copy.

- **Requirements.** `sshfs` + FUSE on the server. Linux: `apt install sshfs`
  (or your distro's package). macOS: `brew install macfuse sshfs`. Not
  supported on Windows.
- **Auth.** Three methods:
  - **SSH agent / host keys** (default) — uses the server's `ssh-agent` and
    `~/.ssh/id_*`.
  - **Key file** — an explicit private key path on the server.
  - **Password** — stored on the server in `~/.wiki-viewer/git-secrets.json`
    (chmod 0600), never written to `config.json`, never logged, never returned
    by any API. It is piped to `sshfs` via stdin, so it never appears in the
    process list.
- **Read-write by default.** Tick **Mount read-only** to mount with `-o ro`
  (every mutating route then returns `403 WORKSPACE_READ_ONLY`, like git
  workspaces).
- **Live, resilient mounts.** Mounted with `reconnect` + keep-alives. The server
  remounts automatically on restart and heals a stale/dropped mount on the next
  request. Removing the workspace unmounts it and deletes any stored password.
- **Live file watch** still works (the search index and the SSE watcher fall
  back to polling, since FUSE has no inotify), so remote-side changes show up.
- **Latency.** Every directory listing and stat is a network round-trip, so a
  remote workspace is slower than local on big trees. The mount enables sshfs
  caching + compression to soften this.

The same thing is available straight from the CLI, symmetric with serving a
local directory:

```bash
# Mount and serve a remote directory (ssh-agent / host keys)
wiki-viewer me@server:/srv/docs

# With an explicit key, mounted read-only
wiki-viewer me@server:/srv/docs --ssh-key ~/.ssh/id_ed25519 --ssh-readonly

# Non-standard port + password (prompted, or set WIKI_SSH_PASSWORD)
wiki-viewer me@host:/data --ssh-port 2222 --ssh-password
```

The CLI mount is ephemeral and is unmounted when the process exits. To keep a
remote workspace across reboots, install it as a service
(`wiki-viewer service install me@server:/srv/docs --ssh-key ~/.ssh/id_ed25519`)
— password auth is rejected there since services run non-interactively, so use
ssh-agent or a key file.

### Admins and access control

Workspace management is **admin-gated** (organizational access control, not
OS-level permissions):

- The **first user to sign up** becomes an admin automatically. Admins can
  promote/demote other users from the settings sheet (gear icon → **Admins**).
  Seed or override admins headlessly with `WIKI_ADMIN_EMAILS` (csv).
- Only admins can create/delete workspaces and edit a workspace's allowed-user
  list (`allowedUserIds`). An empty allow-list means any signed-in user may
  open the workspace (the default). Non-admins with access get full file
  read/write on the workspaces they can see.
- Admin state lives in `~/.wiki-viewer/config.json` (`adminUserIds`), workspace
  records under `workspaces[]`.

> Note: removing a workspace only unregisters it — the directory on disk is
> never touched. The last admin cannot be demoted unless `WIKI_ADMIN_EMAILS`
> provides a fallback.

## Search

Full-text search runs across the whole active workspace. Press the search box
in the sidebar, type a query, and results rank by relevance.

- **FTS5 + BM25.** Backed by a SQLite FTS5 index, separate from `auth.db`, in
  `~/.wiki-viewer/`. Ranking uses BM25.
- **Incremental.** A background initial scan builds the index on first use, then
  a file watcher keeps it current as files change. Search returns results from
  whatever is already indexed, so it is usable while the first scan runs.
- **Scoped per workspace.** Each workspace has its own index. Deleting a
  workspace purges its index. Node-app directories and `.git`, `node_modules`,
  `.next`, `.proof` are skipped. Body indexing is capped at 1 MiB per file.

## Sharing documents

Generate a public, read-only link to any file so people without an account can
read it.

- Open a file and use **Share** to mint a link. It serves a rendered, read-only
  view at `/share/<token>`.
- **Password (optional).** Protect a link with a password; only the hash is
  stored. Visitors unlock before reading.
- **Expiry (optional).** Set a number of days; the link returns `410` once
  expired.
- **View counts.** Each open increments a counter visible in the share dialog.

Share links are managed per file. Creating a link requires being signed in;
reading one does not.

## Node apps

Any directory containing a `package.json` is treated as a runnable node app. In
the file browser it shows a **Launch** button.

- **Pick a script.** Launch runs the default script (`start`, then `preview`
  when a `dist/` exists, then `dev`), or you choose any script from the
  package's `scripts`. A package with only a `main` entry runs that.
- **Proxied.** The child process binds a free local port and is proxied through
  the viewer under `/app-proxy/`, so you view the running app inside
  wiki-viewer. Live status (`installing` / `starting` / `running` / `error`)
  and logs are shown.
- **Package manager auto-detected.** pnpm / yarn / npm based on the lockfile.
- A directory with an `index.html` but no `package.json` is served as a static
  app instead.

> Launching runs arbitrary project code on the host. Only launch apps you
> trust. Git-backed (read-only) workspaces still run apps but reject writes.

## Auth and multi-user mode

wiki-viewer uses [Better Auth](https://better-auth.com) with SQLite. State lives at `~/.wiki-viewer/auth.db` (WAL mode) and `~/.wiki-viewer/auth.secret` (chmod 0600). Both are created on first start. Set `BETTER_AUTH_SECRET` in the environment to override the file-stored secret.

Sign-in providers:

- **Google OAuth.** Enabled when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- **Email + password.** Enabled by default. No verification email is sent.

### Require Google sign-in only

To turn off email/password and force Google OAuth, set `AUTH_DISABLE_PASSWORD=1`:

```bash
wiki-viewer config set AUTH_DISABLE_PASSWORD=1
wiki-viewer service restart
```

The sign-in page then shows only the Google button. As a safety guard, this is ignored unless a Google provider is configured, so you cannot lock yourself out: if `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are missing, email/password stays on and a warning is logged.

### Linking Google to an existing account

Better Auth only auto-links a Google sign-in to an existing account when both sides have a verified email. If you created a password account first (with an unverified email) and then try Google sign-in with the same address, you get an `account_not_linked` error.

To force linking, list the provider in `AUTH_TRUSTED_PROVIDERS`:

```bash
wiki-viewer config set AUTH_TRUSTED_PROVIDERS=google
wiki-viewer service restart
```

This links Google to the existing account even when its email is unverified. It slightly raises account-takeover risk, so enable it only when you control the accounts (for example, consolidating your own login onto Google).

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

wiki-viewer exposes an HTTP API so agents (Claude, Cursor, ChatGPT desktop, custom scripts) can work with files in a running instance — locally or remotely — almost as if they were on their own filesystem. There are **two tiers**, sharing one auth/scope/lock spine:

- **Tier 1 — Raw filesystem** (`/api/agent/fs/*`): `read`, `write`, `edit`, `list`, `search`, `move`, `delete` for **every file type** (code, configs, PDFs, notebooks, Markdown — anything). Fast, boring, byte-accurate. Mutations are audited.
- **Tier 2 — Markdown collaboration** (`/api/agent/files/*`): structured block-ops where every AI-authored insert is wrapped in an inline `<proof-span>` mark so the human reviewer can see, accept, or revert each change, plus comments and suggestions. Tier-2 is API-compatible in spirit with [Proof SDK](https://github.com/EveryInc/proof-sdk).

### Which tier? Working mode vs collaborating mode

Before editing a Markdown file, an agent reads it and checks the **`X-Collab-State`** response header:

| `X-Collab-State` | Meaning                                                          | Agent uses                                                                      |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `active`         | A human has the doc open, or it has pending suggestions/comments | **Tier-2 block-ops** (reviewable). A raw write is rejected `409 COLLAB_ACTIVE`. |
| `tracked`        | Has a collab sidecar, nobody editing now                         | Prefer Tier-2 for prose; raw OK for mechanical edits                            |
| `untracked`      | Plain Markdown, never collaborated on                            | Either tier                                                                     |
| `not-markdown`   | Any non-`.md` file                                               | **Tier-1 raw only**                                                             |

This is enforced, not advisory: the collab state is re-checked atomically inside the write lock, so an agent can never silently clobber a doc you just opened. The browser editor sends a presence heartbeat to drive the `active` state. See [`docs/file-vs-collab-authority.md`](docs/file-vs-collab-authority.md) for the full authority model.

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

### Tier 1 — raw filesystem

Work with any file type. All routes take `Authorization: Bearer <token>` + `X-Agent-Id`, are scope-checked, and reject path traversal, symlink escapes, and anything under `.proof/`.

```bash
# Read (bytes; ETag is the sha256, supports Range, returns X-Collab-State)
curl -sD- -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  https://wiki.team.com/api/agent/fs/file/src/util.ts

# Write/overwrite (atomic). If-Match: <sha256> is required to overwrite;
# omit it to create. ?mkdirs=true creates parent dirs. ?force=true overrides (audited).
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  -H "If-Match: <sha256-from-read>" --data-binary @util.ts \
  https://wiki.team.com/api/agent/fs/file/src/util.ts

# List a directory (scope-filtered)
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  "https://wiki.team.com/api/agent/fs/ls/src?recursive=true&limit=500"

# Search (server-side; kills round-trips)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  -H "Content-Type: application/json" \
  -d '{"kind":"grep","query":"TODO","glob":"**/*.ts"}' \
  https://wiki.team.com/api/agent/fs/search

# Move and delete (delete needs the `delete` scope + If-Match)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  -H "Content-Type: application/json" -d '{"from":"a.md","to":"b.md"}' \
  https://wiki.team.com/api/agent/fs/move
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: ai:claude" \
  -H "If-Match: <sha256>" https://wiki.team.com/api/agent/fs/file/old.md
```

Mutating a Markdown file via raw write emits a `file.rawWritten` event and re-binds the collab sidecar; if the doc is `active` it is rejected `409 COLLAB_ACTIVE` (use Tier-2 instead). Use the **`npx wiki-viewer-mcp`** adapter to get all of this as standard MCP file tools — it handles `If-Match`, mode-awareness, and edit-via-read-then-write for you.

### Tier 2 — op vocabulary (Markdown)

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

| Method   | Path                                     | Required scope        | Tier |
| -------- | ---------------------------------------- | --------------------- | ---- |
| `GET`    | `/api/agent/fs/file/<path>`              | `read` + path match   | 1    |
| `PUT`    | `/api/agent/fs/file/<path>`              | `mutate` + path match | 1    |
| `DELETE` | `/api/agent/fs/file/<path>`              | `delete` + path match | 1    |
| `GET`    | `/api/agent/fs/ls/<path>`                | `read` + path match   | 1    |
| `POST`   | `/api/agent/fs/move`                     | `mutate` (src+dest)   | 1    |
| `POST`   | `/api/agent/fs/search`                   | `read` (per match)    | 1    |
| `GET`    | `/api/agent/files/<path.md>`             | `read` + path match   | 2    |
| `POST`   | `/api/agent/files/<path.md>`             | `mutate` + path match | 2    |
| `GET`    | `/api/agent/events/<path.md>?after=<id>` | `read` + path match   | 2    |
| `POST`   | `/api/agent/events/<path.md>`            | `read` + path match   | 2    |
| `GET`    | `/api/agent/sidecar/<path.md>`           | `read` + path match   | 2    |
| `GET`    | `/api/agent/settings`                    | `read`                | —    |
| `GET`    | `/api/agent/activity`                    | `read`                | —    |

Scopes: `paths` is a glob list (directories work natively, e.g. `notes/**`); `ops` is any of `read`, `mutate` (create/overwrite/move), `delete` (remove). Grant `["read","mutate"]` for edit-but-never-delete.

### Full curl trace

```bash
# 1. Agent registers
curl -s -X POST https://wiki.team.com/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"id":"ai:claude","displayName":"Claude",
       "scope":{"paths":["**/*"],"ops":["read","mutate","delete"]}}'
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
- `409 STALE_REVISION` — refetch and retry. Response includes a fresh snapshot. (Tier 2)
- `409 BLOCK_NOT_FOUND` — the ref no longer exists. (Tier 2)
- `409 IDEMPOTENCY_KEY_REUSED` — same key, different body. (Tier 2)
- `409 COLLAB_ACTIVE` — raw write to a Markdown doc a human is editing; use Tier-2 block-ops (response includes the snapshot URL) or `?force=true`. (Tier 1)
- `412 PRECONDITION_FAILED` — `If-Match` sha mismatch (file changed); re-read and retry. (Tier 1)
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

| Variable               | Description                                                                       | Default               |
| ---------------------- | --------------------------------------------------------------------------------- | --------------------- |
| `ROOT_DIR`             | Directory to serve                                                                | `~/wiki-viewer-files` |
| `PORT`                 | Port to listen on                                                                 | `3000`                |
| `HOSTNAME`             | Host / interface to bind                                                          | `localhost`           |
| `BETTER_AUTH_URL`      | Public origin (required in production, must be `https://`)                        | unset                 |
| `BETTER_AUTH_SECRET`   | Override for the auto-generated session signing secret                            | file-stored           |
| `GOOGLE_CLIENT_ID`     | Enable Google OAuth button                                                        | unset                 |
| `GOOGLE_CLIENT_SECRET` | Enable Google OAuth button                                                        | unset                 |
| `AUTH_ALLOWED_EMAILS`  | csv: only these emails can sign up (overridden by UI allowlist if set)            | unset (open)          |
| `AUTH_ALLOWED_DOMAIN`  | csv: only emails on these domains can sign up (overridden by UI allowlist if set) | unset (open)          |
| `WIKI_OWNER_HOSTS`     | csv: extra hostnames trusted for CSRF Origin check                                | `localhost,127.0.0.1` |
| `WIKI_ALLOW_INSECURE`  | Set to `1` to bypass the prod-https guard (dev / CI only)                         | unset                 |
| `WIKI_ADMIN_EMAILS`    | csv: emails treated as admins (seed/override; otherwise first signup is admin)    | unset                 |
| `AGENT_RATE_LIMIT`     | Max mutation ops per minute per agent identity                                    | `60`                  |
| `WIKI_SSH_PASSWORD`    | Password for a `--ssh-password` CLI mount (avoids the interactive prompt)         | unset                 |

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
│   │   ├── api/wiki/             File browser API (session-gated): search, git-*, app, share
│   │   ├── api/share/           Public share-link resolve/unlock
│   │   ├── api/app-proxy/        Reverse proxy to launched node apps
│   │   ├── api/system/           System config API (session-gated)
│   │   └── signin/               Sign-in page
│   ├── components/
│   │   ├── editor/               TipTap editor + proof-span + comment-pip + suggestion-card
│   │   └── ai-panel/             Right-side AI panel (agents, activity, install)
│   ├── lib/
│   │   ├── auth/                 Better Auth server + client + allowlist + CSRF
│   │   ├── search/               FTS5 indexer + search DB + file-watcher pool
│   │   ├── shared-docs/          Share-link store (tokens, password hash, expiry)
│   │   ├── git.ts                Git history / diff / branch / file-info helpers
│   │   ├── sshfs.ts              SSH (sshfs) mount manager for remote workspaces
│   │   ├── app-runner.ts         Launches and supervises node-app child processes
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
