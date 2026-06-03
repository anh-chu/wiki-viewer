---
name: wiki-viewer
description: Read and edit markdown files in a running wiki-viewer instance over its HTTP collab API. Use when the user mentions wiki-viewer, asks you to edit local notes, or shares a localhost wiki-viewer URL. Handles agent registration, scoped capabilities, block-level edits with provenance marks, comments, and suggestions.
license: MIT
---

# wiki-viewer agent skill

You are working with **wiki-viewer**, a local-first markdown viewer that exposes a Proof-SDK-compatible HTTP API for agents. Files on disk are the source of truth. Every AI-authored edit is wrapped in an inline `<proof-span>` mark so the human can see, accept, or revert your contribution.

## Quick orientation: two tiers

| Tier                | Routes                  | File types                          | When to use                                                                       |
| ------------------- | ----------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| **Tier 1 — Raw FS** | `/api/agent/fs/*`       | All types (markdown, code, binary…) | Fast filework. Read, write, list, move, delete, search. Audited but no review UI. |
| **Tier 2 — Collab** | `/api/agent/files/*.md` | Markdown only                       | Reviewable prose. Edits become proof-spans the human can accept/revert.           |

Both tiers use the same auth (TOFU token). Pick the tier based on `X-Collab-State` (see [Which tier do I use?](#which-tier-do-i-use)).

---

## Discovery

The server publishes everything you need at one URL:

```
GET http://<host>:<port>/api/agents/install
```

This returns JSON with: bootstrap instructions, route table, op vocabulary, the current registration endpoint, and the human-facing approval workflow. Fetch this first and treat it as authoritative for the running instance you're talking to.

If the user pasted only the wiki-viewer URL, append `/api/agents/install` and fetch it before doing anything else.

## Authentication

wiki-viewer uses **TOFU (Trust On First Use)**:

1. You register anonymously. Server stores a pending request.
2. The human approves you in the wiki-viewer AI Panel.
3. You poll, receive a one-shot token, and use it from then on.

### Register

```
POST /api/agent/register
Content-Type: application/json

{
  "id": "ai:<your-name>",
  "displayName": "<readable name>",
  "scope": {
    "paths": ["**/*"],
    "ops": ["read", "mutate"]
  }
}
```

- `id` must match `^ai:[a-z][a-z0-9-]{0,30}$`. Pick something stable per agent identity (e.g. `ai:claude`, `ai:cursor`, `ai:my-script`).
- `displayName` 1-80 chars. What the human sees in the approval UI.
- `scope.paths` is a glob list. Use `**/*` for full repo access, or restrict to a subtree like `notes/**`.
- `scope.ops` ⊆ `["read", "mutate"]`.

Response:

```json
{
  "registrationId": "reg_<32hex>",
  "pollUrl": "/api/agent/register/<regId>",
  "status": "pending"
}
```

**Tell the human**: "Open the wiki-viewer AI Panel and approve my registration."

### Poll

```
GET /api/agent/register/<registrationId>
```

- `202 {status:"pending"}` — keep polling, every 2-5s.
- `200 {status:"approved", agentId, token}` — capture token immediately. Pickup is **one-shot**; you cannot fetch it again.
- `410 {status:"denied"}` or `{status:"consumed"}` — abort or restart registration.
- `404` — registration expired, re-register.

### Use the token

Every subsequent request:

```
Authorization: Bearer <token>
X-Agent-Id: ai:<your-name>
```

The `X-Agent-Id` must match the id the token was issued for. Spoofing rejected with `401`.

## Reading

```
GET /api/agent/files/<url-encoded-path>.md
```

Returns a Snapshot:

```json
{
  "path": "notes/plan.md",
  "revision": 7,
  "fingerprint": "sha256:...",
  "blocks": [
    { "ref": "b1a3f0", "type": "heading", "level": 1, "markdown": "# Plan" },
    { "ref": "b7f2c1", "type": "paragraph", "markdown": "Ship in June." }
  ],
  "comments": [...],
  "suggestions": [...],
  "lastEventId": 12
}
```

Block `ref` strings are stable across edits. Use them to target mutations. **Always read a fresh snapshot before mutating** so you have the current `revision`.

## Mutating

```
POST /api/agent/files/<path>.md
Authorization: Bearer <token>
X-Agent-Id: ai:<your-name>
Content-Type: application/json
Idempotency-Key: <uuid you generate per request>

{
  "baseRevision": <revision from snapshot>,
  "by": "ai:<your-name>",
  "ops": [ <op>, ... ]
}
```

Requirements:

- `Idempotency-Key` header mandatory. Same key + same body within 5 minutes returns the cached response. Same key + different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- `by` must equal your `X-Agent-Id` or you get `403 FORBIDDEN`.
- If `baseRevision` is stale, response is `409 STALE_REVISION` with a fresh snapshot. Read the new revision, rebuild your op against current refs, retry.

### Op vocabulary

**Block ops** — content edits:

```json
{ "type": "block.replace",      "ref": "b7f2c1", "markdown": "New content." }
{ "type": "block.insertAfter",  "ref": "b7f2c1", "markdown": "..." }
{ "type": "block.insertBefore", "ref": "b7f2c1", "markdown": "..." }
{ "type": "block.delete",       "ref": "b7f2c1" }
{ "type": "block.append",       "markdown": "..." }
{ "type": "block.prepend",      "markdown": "..." }
```

Any text you insert is automatically wrapped in a `<proof-span>` mark by the server. Provide optional metadata to make your contribution legible:

```json
{
  "type": "block.insertAfter",
  "ref": "b7f2c1",
  "markdown": "Three pillars: infra, tooling, launch.",
  "basis": "described",
  "basisDetail": "user asked for an opening paragraph",
  "inResponseTo": "c4a1"
}
```

`basis` ∈ `"described" | "inferred" | "suggested"`. Defaults to `"inferred"`. Always set `basis` and a short `basisDetail` so the human reviewer knows where your edit came from.

**Comment ops** — threaded discussion attached to a block:

```json
{ "type": "comment.add",     "ref": "b7f2c1", "text": "Why end of June?" }
{ "type": "comment.reply",   "commentId": "c4a1", "text": "Because of API freeze." }
{ "type": "comment.resolve", "commentId": "c4a1" }
{ "type": "comment.reopen",  "commentId": "c4a1" }
```

**Suggestion ops** — proposed edits the human must accept:

```json
{
  "type": "suggestion.add",
  "ref": "b7f2c1",
  "kind": "replace",
  "markdown": "Ship the rewrite by July 15.",
  "basis": "described",
  "basisDetail": "user mentioned slippage in chat"
}
```

Suggestion kinds: `"replace" | "insertAfter" | "insertBefore" | "delete"`.

Default for AI-initiated content edits: **prefer suggestions over direct block ops** unless the human explicitly asked you to write directly. Suggestions render as inline cards in the editor with Accept / Reject buttons. Block ops apply immediately and only show up as proof-span decorations.

## Polling events

```
GET /api/agent/events/<path>.md?after=<lastEventId>
```

Returns events emitted since `lastEventId`: human comments, accepted suggestions, external file edits (the human opened the file in vim), and so on. Use this to react when the human responds to one of your comments or suggestions.

Acknowledge:

```
POST /api/agent/events/<path>.md
{ "upToId": <id>, "by": "ai:<your-name>" }
```

Acks are advisory; events are never deleted.

## Error codes

| Status | Code                   | Meaning                                            |
| ------ | ---------------------- | -------------------------------------------------- |
| 401    | UNAUTHORIZED           | bad/missing token or X-Agent-Id                    |
| 403    | FORBIDDEN              | scope mismatch, or `by` doesn't match `X-Agent-Id` |
| 404    | FILE_NOT_FOUND         | path doesn't exist under server root               |
| 409    | STALE_REVISION         | `baseRevision` wrong, retry with included snapshot |
| 409    | BLOCK_NOT_FOUND        | ref no longer exists, refetch snapshot             |
| 409    | IDEMPOTENCY_KEY_REUSED | same key, different body                           |
| 422    | INVALID_MARKDOWN       | op's markdown failed to parse                      |
| 429    | RATE_LIMITED           | bucket exhausted, honor `Retry-After` header       |

---

## Working with files (raw filesystem — Tier 1)

All Tier-1 routes require `Authorization: Bearer <token>` + `X-Agent-Id: ai:<name>` (same as Tier 2). The agent's `scope.paths` glob applies to every surface (reads, ls results, search results, move, delete).

### Scope ops

When registering, `scope.ops` can include:

- `read` — read files + list + search
- `mutate` — create / overwrite / move
- `delete` — remove files/dirs (separate from mutate so a human can grant edit-but-never-delete)

Example registration with full access:

```json
{
  "id": "ai:claude",
  "scope": { "paths": ["**/*"], "ops": ["read", "mutate", "delete"] }
}
```

### Read a file

```
GET /api/agent/fs/file/<path>
```

Returns raw bytes. Metadata in response headers:

```
ETag: "<sha256>"
X-File-Size: <bytes>
X-File-Mtime: <ISO-8601>
Content-Type: <mime>
X-Collab-State: active | tracked | untracked | not-markdown
X-Collab-Revision: <n>
X-Collab-Snapshot: /api/agent/files/<path>.md   # when applicable
```

Supports `Range` header for large/binary files.

### Write a file

```
PUT /api/agent/fs/file/<path>
If-Match: "<sha256>"          # required for overwrites; omit for creates
Content-Type: <mime>
<raw bytes body>
```

- **Create** (file doesn't exist): omit `If-Match`. Creating a file that already exists without `If-Match` → 412 (no blind clobber).
- **Overwrite** (file exists): send `If-Match` with the sha256 you read. Mismatch → 412.
- `?mkdirs=true` — create parent directories.
- `?force=true` — bypass `If-Match` check (audited; use sparingly).

For `.md` files, also send:

```
If-Collab-Match: <X-Collab-Revision>   # prevents writing into a live collab session
```

(See [Which tier do I use?](#which-tier-do-i-use).)

Response:

```json
{
  "path": "...",
  "sha256": "...",
  "size": 1234,
  "mtime": "...",
  "created": false
}
```

### Delete a file

```
DELETE /api/agent/fs/file/<path>
If-Match: "<sha256>"    # required — you must have read the file first
```

Requires `delete` in `scope.ops`. Deletes the `.proof/` sidecar too for `.md` files. For directories: `?recursive=true`.

### List a directory

```
GET /api/agent/fs/ls/<path>?recursive=true&limit=500&depth=3
```

Returns `{ entries: [{name, type, path, size, mtime}] }`. Unauthorized paths silently omitted. Excludes `.proof/`.

### Move / rename

```
POST /api/agent/fs/move
Content-Type: application/json

{ "from": "notes/old.md", "to": "notes/new.md", "ifMatch": "<sha256>" }
```

Moves the `.proof/` sidecar for `.md` files automatically.

### Search (grep / glob)

```
POST /api/agent/fs/search
Content-Type: application/json

{ "kind": "grep", "query": "TODO", "path": "src", "glob": "*.ts", "limit": 100 }
```

```
POST /api/agent/fs/search
Content-Type: application/json

{ "kind": "glob", "query": "**/*.test.ts" }
```

Server-side: one call replaces dozens of `ls`+`read` round-trips. Results are scope-filtered. Glob dialect: `**`, `*`, `?` only (no braces/negation in v1).

### Error codes (Tier 1)

| Status | Code                | Meaning                                                                     |
| ------ | ------------------- | --------------------------------------------------------------------------- |
| 400    | BAD_REQUEST         | Invalid path or body                                                        |
| 401    | UNAUTHORIZED        | Bad/missing token or X-Agent-Id                                             |
| 403    | FORBIDDEN           | Scope mismatch or missing `delete` op                                       |
| 404    | NOT_FOUND           | Path doesn't exist                                                          |
| 409    | COLLAB_ACTIVE       | Raw PUT rejected — doc is active-collab; use Tier-2 or send If-Collab-Match |
| 412    | PRECONDITION_FAILED | If-Match sha mismatch (concurrent modification)                             |
| 413    | PAYLOAD_TOO_LARGE   | File exceeds 50 MB limit                                                    |
| 429    | RATE_LIMITED        | Honor `Retry-After`                                                         |

---

## Which tier do I use?

Every `GET /api/agent/fs/file/<path>` (and every Tier-2 snapshot read) returns `X-Collab-State`.

| `X-Collab-State` | Meaning                                                                                       | Use                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `active`         | Human has this `.md` open in the editor, OR it has pending suggestions / unresolved comments. | **Tier 2 block-ops only.** A raw `PUT` returns `409 COLLAB_ACTIVE`.                                  |
| `tracked`        | `.md` has a sidecar (prior collab history), no active session.                                | Prefer Tier-2 for prose/semantic edits. Raw ok for mechanical/whole-file ops (reformat, regenerate). |
| `untracked`      | `.md`, no sidecar yet.                                                                        | Raw is fine. Tier-2 creates a sidecar (starts provenance tracking).                                  |
| `not-markdown`   | Any non-`.md` file.                                                                           | **Tier-1 raw only.** Tier 2 does not apply.                                                          |

**Rule (one sentence):** Read the file, check `X-Collab-State`, use Tier-2 if `active`, else use Tier-1. For non-markdown, always Tier-1.

**Editing a `.md` safely:**

```
1. GET /api/agent/fs/file/<path>.md
   → note ETag (sha256) and X-Collab-Revision + X-Collab-State

2a. If X-Collab-State == "active":
    → POST /api/agent/files/<path>.md  (block-ops, Tier-2)
      Use the X-Collab-Snapshot URL. See "Mutating" section below.

2b. Otherwise (tracked / untracked):
    → PUT /api/agent/fs/file/<path>.md  (raw Tier-1)
         If-Match: "<ETag from step 1>"
         If-Collab-Match: <X-Collab-Revision from step 1>

3. If you get 409 COLLAB_ACTIVE: the doc became active after your read.
   Switch to Tier-2 (block-ops) using the URL in the response body.
```

**MCP-capable agents:** run `npx wiki-viewer-mcp` (set `WIKI_VIEWER_URL`, `WIKI_VIEWER_TOKEN`, `WIKI_VIEWER_AGENT_ID`). It exposes **Tier-1 file tools only** — `read_file`, `write_file`, `edit_file`, `list_directory`, `search`, `move_file`, `delete_file` — and reads `X-Collab-State` so it won't clobber an active doc: it blocks the write and tells you to use the collaborative path instead. The MCP shim has **no Tier-2 (block-ops / suggestion / comment) tools** — to co-write a doc, use the Tier-2 HTTP endpoints described above directly (the skill instructions cover them). Use the MCP for fast filework; use Tier-2 HTTP for reviewable doc collaboration.

---

## Working style

- Read before write. Always GET a fresh snapshot to capture current `revision` and block `ref`s.
- One file per request. There is no batch-across-files endpoint.
- Atomic ops. Each POST applies all its ops or none. Order matters within a batch.
- Be transparent. Set `basis` + `basisDetail` on every content op.
- Prefer comments and suggestions over silent edits. The human is your collaborator, not your reviewer-of-last-resort.
- Poll events between turns when the human is reviewing your work; respond to their comments rather than re-litigating.

## Sample first interaction

```
1. GET /api/agents/install                               # discovery
2. POST /api/agent/register                              # register (include "delete" in ops if needed)
3. tell human: "approve me in the AI Panel"
4. GET /api/agent/register/<regId>                       # poll until approved

# Working mode (Tier-1, e.g. code files or untracked .md)
5. GET /api/agent/fs/ls/src?recursive=true               # list
6. GET /api/agent/fs/file/src/main.ts                    # read -> capture ETag
7. PUT /api/agent/fs/file/src/main.ts (If-Match: <sha>) # write

# Collaborating mode (Tier-2, active .md)
5. GET /api/agent/fs/file/notes/plan.md                  # read -> X-Collab-State: active
6. GET /api/agent/files/notes/plan.md                    # read snapshot (Tier-2)
7. POST /api/agent/files/notes/plan.md                   # suggest or mutate (Tier-2)
8. GET /api/agent/events/notes/plan.md?after=<id>        # listen for replies
```
