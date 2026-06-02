# wiki-viewer-mcp

MCP filesystem adapter for [wiki-viewer](https://github.com/anh-chu/wiki-viewer).

Maps standard MCP filesystem tools onto the wiki-viewer agent HTTP API so Claude Code, Cursor, and Codex get native-feeling file tools against a **remote** wiki-viewer instance.

## Installation

```bash
npx wiki-viewer-mcp
# or install globally
npm i -g wiki-viewer-mcp
```

## Configuration

Set three environment variables before starting the MCP server:

| Var                    | Description                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `WIKI_VIEWER_URL`      | Base URL of your wiki-viewer instance, e.g. `https://notes.example.com` |
| `WIKI_VIEWER_TOKEN`    | Bearer token from TOFU registration (`GET /api/agents/install`)         |
| `WIKI_VIEWER_AGENT_ID` | Your agent ID, sent as `X-Agent-Id` on every request                    |

## Usage in Claude Code / Cursor / Codex

Add to your `mcp.json` (or equivalent):

```json
{
  "servers": {
    "wiki-viewer": {
      "command": "npx",
      "args": ["wiki-viewer-mcp"],
      "env": {
        "WIKI_VIEWER_URL": "https://notes.example.com",
        "WIKI_VIEWER_TOKEN": "<your-token>",
        "WIKI_VIEWER_AGENT_ID": "<your-agent-id>"
      }
    }
  }
}
```

## Available tools

| Tool             | Maps to                            | Description                                     |
| ---------------- | ---------------------------------- | ----------------------------------------------- |
| `read_file`      | `GET /api/agent/fs/file/<path>`    | Read file bytes; captures sha256 + collab state |
| `write_file`     | `PUT /api/agent/fs/file/<path>`    | Atomic whole-file write with If-Match           |
| `edit_file`      | read → str-replace → PUT           | Client-side exact-string replacement            |
| `list_directory` | `GET /api/agent/fs/ls/<path>`      | Scope-filtered directory listing                |
| `search`         | `POST /api/agent/fs/search`        | Server-side grep or glob                        |
| `move_file`      | `POST /api/agent/fs/move`          | Rename/move; sidecar handled by server          |
| `delete_file`    | `DELETE /api/agent/fs/file/<path>` | Delete; requires `delete` scope                 |

## Working mode vs Collaborating mode (important)

wiki-viewer has two tiers for `.md` files:

- **Tier 1 (raw fs)** — fast, all file types, light audit. Use for code, config, non-prose, or whole-file rewrites.
- **Tier 2 (collab)** — block-ops + proof-spans, review/accept/revert by humans. Use for prose that a human is co-editing.

The shim enforces this automatically in three layers:

### Layer 1 — discoverable (headers)

Every `read_file` response includes:

```
X-Collab-State: active | tracked | untracked | not-markdown
X-Collab-Revision: <n>
X-Collab-Snapshot: /api/agent/files/<path>.md
```

| State          | Meaning                                                      | You should                             |
| -------------- | ------------------------------------------------------------ | -------------------------------------- |
| `active`       | Human has the doc open OR there are pending review artifacts | **Use Tier-2 block-ops**               |
| `tracked`      | Sidecar exists, no active review                             | Prefer Tier-2 for prose/semantic edits |
| `untracked`    | Plain `.md`, no collaboration history                        | Raw ok                                 |
| `not-markdown` | Not a `.md` file                                             | Raw only                               |

### Layer 2 — client-side guard

If the shim's last-known `X-Collab-State` for a `.md` is `active`, `write_file` and `edit_file` are **blocked** before any HTTP request is made. The tool returns a clear error with the Tier-2 snapshot URL.

### Layer 3 — server-side enforcement (409)

Even if the cache is stale, the server re-checks collab state **atomically inside the write mutex**. A raw `PUT` to an `active` `.md` is rejected with `409 COLLAB_ACTIVE` and the Tier-2 snapshot URL. The shim surfaces this as a clear error message.

### Rule

> Before editing a `.md`, run `read_file` and check `X-Collab-State`.  
> If `active`, use wiki-viewer block-ops (Tier 2).  
> For everything else, use raw fs tools.

## If-Match concurrency

The shim caches the sha256 from every `read_file` response (ETag header). `write_file`, `edit_file`, and `delete_file` automatically send this as `If-Match`. If the file changed since your read, you get a `412` error with instructions to re-read.

`edit_file` always reads fresh before writing, so it's naturally atomic per-op.

Use `force: true` to bypass `If-Match` (audited by the server).

## Scope

Your token's `scope.paths` (set during registration) governs what paths you can touch. Paths outside scope, and internal paths (`.proof/`, `.locks/`, the app db), are rejected by the server. Scope supports `**`, `*`, `?` glob patterns.

The `delete` op is a separate scope permission from `mutate` — an agent can be granted "edit but never delete."

## Development

```bash
cd packages/wiki-viewer-mcp
pnpm install
pnpm test      # runs unit tests with tsx --test
pnpm build     # compiles to dist/
```

Tests use a mock fetch — no real wiki-viewer instance needed.
