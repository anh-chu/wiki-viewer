# Review Loop Recon: Tier-2 Sidecar, MCP, Event Bus, and Prompt Injection

## 1. Tier-2 Sidecar Storage: Comment/Suggestion Types and Application Path

### Type Definitions
**File:** `src/lib/proof/types.ts:1–160`

**Comment structure:**
- `Comment.id`: string (`"c" + 4-hex`)
- `Comment.ref`: optional block ref (markdown-only)
- `Comment.lineAnchor`: optional `LineAnchor` for text-file comments (line number + text hash)
- `Comment.resolved`: boolean
- `Comment.turns`: array of `CommentTurn` (`by`, `text`, `at`)
- `Comment.stale`: set true when raw .md overwrite orphans the anchor ref

**Suggestion structure:**
- `Suggestion.id`: string (`"s" + 4-hex`)
- `Suggestion.ref`: string (block ref, markdown-only)
- `Suggestion.kind`: `"replace" | "insertAfter" | "insertBefore" | "delete"`
- `Suggestion.status`: `"pending" | "accepted" | "rejected"`
- `Suggestion.markdown`: optional (omitted for `kind=delete`)
- `Suggestion.basis`: optional provenance basis
- `Suggestion.stale`: set true when orphaned by raw edit

**Op types** (`src/lib/proof/types.ts:115–160`):
- `comment.add`: requires `ref` (for markdown) OR `lineAnchor` (for text files); includes `text`
- `comment.reply`: `commentId`, `text`
- `suggestion.add`: `ref`, `kind`, optional `markdown`, optional `basis`, optional `status`

### Application Path: Comment and Suggestion

**File:** `src/lib/proof/ops-applier.ts:150–430` (the `applyOps()` function)

#### Comment Path (markdown):
1. **Add**: Lines 383–403
   - Resolve ref against current blocks: `resolveRef(workingSidecar, op.ref, refs)`
   - If not found: return 409 `BLOCK_NOT_FOUND`
   - Create `Comment` with `id`, `ref` (resolved), `resolved: false`, `turns: [{by, text, at}]`
   - Push to `workingSidecar.comments`
   - Emit event: `{ type: "comment.added", at, by, commentId, ref, text }`

2. **Reply**: Lines 405–415
   - Find existing comment by `commentId`
   - Push turn to `comment.turns`
   - Emit event: `{ type: "comment.replied", at, by, commentId, text }`

3. **Resolve/Reopen**: Lines 417–438
   - Toggle `comment.resolved` boolean
   - Emit event: `{ type: "comment.resolved" | "comment.reopened", at, by, commentId }`

#### Text Comment Path (non-markdown):
**File:** `src/lib/proof/ops-applier.ts:120–145` (the `applyTextCommentOps()` function)

- For `.txt`, `.json`, `.yaml` etc., only `comment.add` is allowed
- Requires `lineAnchor: { lineStart, lineEnd, textHash }`
- Validates text hash against current file lines
- Creates `Comment` with `lineAnchor` (no `ref`)
- Same event emission as markdown

#### Suggestion Path (markdown only):
**File:** `src/lib/proof/ops-applier.ts:490–570`

1. **Add**: Lines 490–545
   - Resolve `ref` against current blocks
   - Create `Suggestion` with `id`, `ref` (resolved), `kind`, `markdown`, `status: "pending"`
   - If `op.status === "accepted"`: apply immediately
     - Mark as accepted, move to `archivedSuggestions`
     - Recursively apply as inline block op (replace/insertAfter/insertBefore/delete)
   - Otherwise: push to `workingSidecar.suggestions`
   - Emit events

2. **Accept**: Lines 547–578
   - Find suggestion by ID
   - Move to `archivedSuggestions`, update `status`, set `resolvedAt`, `resolvedBy`
   - **Auto-supersede** other pending suggestions for same `ref`:
     - Mark as rejected, move to archived, emit rejection event
   - Apply suggestion as block op (recursively pushes to ops array)
   - Emit: `{ type: "suggestion.accepted", at, by, suggestionId }`

3. **Reject**: Lines 580–593
   - Find suggestion by ID
   - Move to `archivedSuggestions`, update status
   - Emit: `{ type: "suggestion.rejected", at, by, suggestionId }`

### Block Ref Resolution
**File:** `src/lib/proof/block-refs.ts` (referenced in ops-applier)

- `resolveRef(sidecar, ref, currentRefs)`: resolves a ref through `refAliases` map (one generation of rename history)
- Returns resolved ref or `null` if not found
- Used by all comment/suggestion ops to anchor to current block identity

### Sidecar Persistence
**File:** `src/lib/proof/sidecar.ts:1–60`

- `readSidecar(rootDir, mdPath)`: reads from `.proof/<mdPath>.json`
- `writeSidecar(rootDir, mdPath, sidecar)`: atomic write (write to `.tmp`, rename)
- Sidecar location: `.proof/` directory mirrors source tree structure

### Mutation Tracking
**File:** `src/lib/proof/ops-applier.ts:560–580`

After ops applied:
- Increment `workingSidecar.revision`
- Update `workingSidecar.updatedAt`
- Update `workingSidecar.fingerprint` (sha256 of new markdown)
- Update `workingSidecar.refMap` (block ref → text hash mapping)
- Emit all collected events with `emitEvents(sidecar, workingEvents)`
- Trim events if `revision % SIDECAR_TRIM_EVERY_N_MUTATIONS === 0`
- **Atomic write**: update markdown file, then sidecar

---

## 2. `.proof/` Watching and Browser Push

### File Watching Status
**FINDING: `.proof/` changes are NOT currently watched or pushed to browser.**

Search results from `src/app/api/wiki/watch` and proof store code:
- `src/lib/proof/event-bus.ts`: only provides `emitEvents()` and `pollEvents()` (in-memory operations on sidecar object)
- `src/stores/proof-store.ts:50–130`: implements `pollEvents(path)` as **HTTP polling**, not file watching
  - Fetches `/api/agent/events/<path>?after=<lastEventId>` on demand
  - No automatic watch/push infrastructure
- `src/lib/proof/activity.ts`: aggregates events from sidecars at query time (`aggregateActivity()`)
- Watch directory: `src/app/api/wiki/watch` exists but is separate from proof infrastructure

### Proof Event Flow Today
1. Agent applies ops → ops-applier mutates sidecar in-memory, writes `.proof/<path>.json`
2. Client calls `pollEvents(path)` manually or on interval
3. Server reads sidecar from disk, filters events, returns
4. Client-side store applies events to local state

**No file system watcher emitting SSE/WebSocket events for `.proof/` changes.**

### Implication for Review Loop
- `.proof/` sidecar updates are write-through to disk but not watched
- Browser receives proof updates only via explicit HTTP poll (proof-store `pollEvents`)
- **Opportunity**: Add chokidar watch on `.proof/` directory and emit SSE events to connected clients

---

## 3. Activity API Shape

**File:** `src/app/api/agent/activity/route.ts:1–50`

**API Endpoint:** `GET /api/agent/activity?limit=<int>&file=<path>`

**Response:**
```typescript
{
  events: ActivityEvent[],
  count: number
}
```

**ActivityEvent fields** (extends `ProofEvent`):
- `id`: number (monotonic per sidecar)
- `type`: string (e.g., `"comment.added"`, `"suggestion.accepted"`, `"block.replaced"`, `"file.externallyEdited"`)
- `at`: ISO 8601 timestamp
- `by`: string (e.g., `"human"`, `"ai:claude"`, `"system"`)
- `path`: string (file path, injected from sidecar)
- Additional fields depend on `type`:
  - `comment.added`: `commentId`, `ref` (or `lineAnchor`), `text`
  - `suggestion.added`: `suggestionId`, payload varies by kind
  - `block.replaced`: `ref`, `newRef`
  - `file.rawWritten`: `oldSha`, `newSha`

**Helper:** `deriveConnections(events)` (from `src/lib/proof/activity-shared.ts`)
- Filters events from last 5 minutes
- Groups by `by` field
- Returns `[{ by, opCount, lastSeen }, ...]`

---

## 4. Agent Prompt/Skill Delivery Mechanism

### Agent Skills Directory
**File:** `agents/bootstrap-prompt.md` and `agents/wiki-viewer-skill/` (location: `/home/sil/wiki-viewer/agents/`)

- Skills are stored on disk
- Served via HTTP endpoint (see below)

### Agent Skill API
**File:** `src/app/api/agents/skill/route.ts:1–20`

**Endpoint:** `GET /api/agents/skill`

- Reads file: `agents/wiki-viewer-skill/SKILL.md`
- Returns as `text/markdown` with `Cache-Control: no-store`
- Used by agents to fetch their skill prompt at runtime

### Agent Registration and Token Delivery
**File:** `packages/wiki-viewer-mcp/src/register.ts` (in MCP adapter)

- Agents call `POST /api/agent/register` with `id`, `displayName`, `scope`
- Returns `{ registrationId, pollUrl, status: "pending" }`
- Agent polls `GET <pollUrl>` until `status: "approved"`, then receives `{ token, agentId }`
- Token + agent ID are set as env vars in agent's MCP server

**Token is NOT injected into a live tmux session.** Instead:
- Agent is launched with env vars set at startup
- MCP server reads env vars and authenticates all subsequent HTTP calls to wiki-viewer API

### Collab-State Awareness in MCP
**File:** `packages/wiki-viewer-mcp/src/index.ts:180–250`

- Before raw write to `.md` file, MCP adapter checks cached `X-Collab-State` from last read
- If `"active"`, blocks the write with error message instructing agent to use block-ops
- Server enforces with 409 `COLLAB_ACTIVE` response

**NO mechanism exists today to inject new prompts into a live agent session.**

---

## 5. Editor Comment UI Surfaces

### Comment Pip (Gutter Indicator)
**File:** `src/components/editor/comment-pip.tsx:1–70`

**Props:**
- `anchorKey`: string (visual identifier)
- `anchorLabel`: optional string (display label)
- `comments`: `Comment[]` array
- `top`, `left`: number (absolute px positioning)
- `onClick`: callback to open thread

**Anchoring:** Uses `anchorKey` and `comments` array; no direct block-ref dependency in props
- Block ref is stored in `Comment.ref` (inside the `comments` array)
- Pip is positioned by parent editor using `top`/`left` (computed by parent)

**Styling:**
- Renders CheckCircle2 if all resolved
- Renders MessageCircle (filled) if unresolved AI turn
- Renders MessageCircle (outline) if unresolved human turn

### Comment Thread (Modal Popover)
**File:** `src/components/editor/comment-thread.tsx:1–200`

**Props:**
- `path`: string (file path)
- `anchorKey`: string (for header display)
- `anchorLabel`: optional string
- `anchorRef`: optional string (block ref for markdown comments)
- `lineAnchor`: optional `LineAnchor` (for text-file comments)
- `comments`: `Comment[]` array
- `anchorEl`: HTMLElement | null (positioning anchor)
- `onClose`: callback
- `readOnly`: optional boolean

**Behavior:**
- Displays all turns from all comments in `comments` array
- On send: posts op `comment.add` (with `ref` or `lineAnchor`) or `comment.reply`
- On resolve: posts op `comment.resolve` or `comment.reopen`
- Gets revision from `useProofStore.getState().byPath[path].snapshotRevision`
- POSTs to `POST /api/agent/files/<path>` with `{ baseRevision, by, ops }`

**Anchor types accepted:**
- Markdown: `anchorRef` (block ref) — stored as `Comment.ref`
- Text files: `lineAnchor` (line range + hash) — stored as `Comment.lineAnchor`

### Suggestion Card (Inline Card)
**File:** `src/components/editor/suggestion-card.tsx:1–150`

**Props:**
- `suggestion`: `Suggestion` object
- `currentMarkdown`: string (current block text for diff display)
- `path`: string (file path)
- `baseRevision`: number
- `getLatestRevision`: function returning current known revision
- `top`, `left`, `width`: number (absolute positioning)
- `onSettled`: callback after accept/reject
- `readOnly`: optional boolean

**Behavior:**
- Displays two-pane diff for `kind="replace"`
- Displays proposed content with label for `kind="insertAfter"/"insertBefore"`
- Displays struck-through current for `kind="delete"`
- Accept: posts `suggestion.accept`; on 409 retry with fresh revision
- Reject: posts `suggestion.reject`
- On success: calls `onSettled()` for parent to refresh

**Anchor type:** Accepts only block `ref` (Suggestion.ref is always a block ref)

### Proof Store (Client State Management)
**File:** `src/stores/proof-store.ts:1–100`

**State:**
```typescript
byPath: Record<string, {
  sidecar: Sidecar | null,
  snapshotRevision: number,
  lastEventId: number,
  snapshotBlocks: Block[]
}>
```

**Methods:**
- `loadSidecar(path)`: fetches `GET /api/agent/sidecar/<path>`, caches entire sidecar
- `loadSnapshot(path)`: fetches `GET /api/agent/files/<path>`, caches blocks + revision
- `pollEvents(path)`: fetches `GET /api/agent/events/<path>?after=<lastEventId>`, applies to local state
- `applyEvent(path, e)`: mutates sidecar in-memory based on event type

**Both comment and suggestion components use:**
- `getRevision()` → `useProofStore.getState().byPath[path].snapshotRevision`
- Post ops to `/api/agent/files/<path>` with this revision

---

## 6. MCP Adapter File Tools Surface

**File:** `packages/wiki-viewer-mcp/src/index.ts:60–145` (TOOLS array)

### Exposed File Tools (names only):
1. **read_file** — reads file + captures ETag (sha256) + `X-Collab-State` header
2. **write_file** — writes file with optional If-Match guard + collab-state check
3. **edit_file** — edit by exact string replacement (server-side PATCH or read+PUT fallback)
4. **list_directory** — list with recursive/depth/limit options
5. **search** — grep or glob search (server-side)
6. **move_file** — move/rename; auto-moves .md sidecars
7. **delete_file** — delete with If-Match guard; auto-deletes sidecars

### Authentication
**File:** `packages/wiki-viewer-mcp/src/index.ts:70–90` and `http-client.ts`

- **Env vars:**
  - `WIKI_VIEWER_URL`: base URL of wiki-viewer instance
  - `WIKI_VIEWER_TOKEN`: Bearer token from TOFU registration
  - `WIKI_VIEWER_AGENT_ID`: agent ID (e.g., `"ai:claude"`)
  - `WIKI_VIEWER_WORKSPACE`: optional workspace ID

- **HTTP headers sent on every request:**
  - `Authorization: Bearer <token>`
  - `X-Agent-Id: <agentId>`
  - `X-Workspace: <workspace>` (if set)

- **State caching:**
  - `state-cache.ts`: caches sha256 (ETag) and `X-Collab-State` from reads
  - Before write, checks cache; if `X-Collab-State === "active"`, blocks write

### Collab-Active Behavior
**File:** `packages/wiki-viewer-mcp/src/index.ts:240–290`

If a `.md` file is collab-active:
- Returns error message instructing agent to use block-ops instead
- Provides link to `X-Collab-Snapshot` (the snapshot API URL) for context
- Agent must re-prompt user or fall back to block-ops

---

## 7. Guppi/Termyard Prompt Injection: NOT IMPLEMENTED FOR EXTERNAL CALLERS

### Tmux Hook Configuration
**File:** `/home/sil/guppi/.omx/tmux-hook.json`

```json
{
  "enabled": true,
  "target": { "type": "pane", "value": "%2" },
  "allowed_modes": ["ralph", "ultrawork", "team"],
  "cooldown_ms": 15000,
  "max_injections_per_session": 200,
  "prompt_template": "Continue from current mode state. [OMX_TMUX_INJECT]",
  "marker": "[OMX_TMUX_INJECT]",
  "dry_run": false,
  "log_level": "info",
  "skip_if_scrolling": true
}
```

**Target:** Identifies pane by ID (`"%2"`) — NOT injectable externally

### Injection Logs
**File:** `/home/sil/guppi/.omx/logs/tmux-hook-2026-04-09.jsonl`

Example log entry:
```json
{
  "timestamp": "2026-04-09T01:23:00.683Z",
  "type": "tmux_hook",
  "mode": "ralph",
  "reason": "target_not_found",
  "target": { "type": "pane", "value": "%2" },
  "sent": false,
  "event": "injection_skipped"
}
```

**Key observation:** All logs show `"sent": false, "event": "injection_skipped"` with `"reason": "target_not_found"` — **NO successful injections found.**

### Tmux Client Infrastructure
**File:** `pkg/tmux/client.go` (lines 1–300+)

**Available methods:**
- `ListSessions()`, `ListWindows()`, `ListPanes()`, `ListAllPanes()`
- `SelectPane()`, `SelectWindow()`, `SelectLayout()`
- `NewSession()`, `NewWindow()`, `SplitWindow()`
- `RenameSession()`, `KillSession()`
- `CapturePaneContent()`, `CapturePaneHistory()`
- `PrimaryPaneID()` — resolves active pane for a session

**NO method named `SendKeys()`, `InjectKeys()`, or `SendKeySequence()`.**

### PTY Paste Infrastructure (NOT applicable to prompt injection)
**File:** `pkg/tmux/paste_image.go`

- `HandlePTYControlMessage()`: processes incoming PTY messages like `"paste-image"`, `"paste-file"`, `"resize"`
- `StorePastedImage()`, `StorePastedFile()`: store uploads to temp directory
- Stores file path, writes to pane via `ptySess.Write()`

**This is for WebSocket ↔ PTY bridging, not for external prompt injection.**

### Control Mode (Notification Listener Only)
**File:** `pkg/tmux/controlmode.go` (lines 1–300+)

- `ControlMode` connects to tmux in control mode (`-C` flag)
- Reads notifications: `%sessions-changed`, `%window-add`, `%output`, etc.
- Triggers debounced state refresh on notifications
- NO sending capability — only receives notifications

### Conclusion on Prompt Injection
**FINDING: No HTTP/socket endpoint exists in guppi for external systems (like wiki-viewer) to inject prompts into tmux panes.**

The tmux-hook infrastructure is **internal to guppi**:
- Runs as a background service
- Targets a specific pane configured in `.omx/tmux-hook.json`
- Injects based on internal state/logic, not external requests

**To implement the converged design, a new mechanism is needed:**
- Either: add an HTTP endpoint to guppi for wiki-viewer to call (e.g., `POST /api/inject-prompt`)
- Or: use a Unix socket or file-based coordination (e.g., write `.inject/<thread-id>.json`, poll by guppi)

---

## Summary of Findings

| Item | Location | Status | Notes |
|------|----------|--------|-------|
| **Comment/Suggestion Types** | `src/lib/proof/types.ts` | ✓ Found | `Comment.ref` for markdown, `Comment.lineAnchor` for text; `Suggestion.ref` always block ref |
| **Application Path** | `src/lib/proof/ops-applier.ts:120–593` | ✓ Found | `comment.add` / `comment.reply` / `suggestion.add` / `suggestion.accept` all resolve ref and emit events |
| **Sidecar Persistence** | `src/lib/proof/sidecar.ts` | ✓ Found | `.proof/<path>.json` atomic writes; `refMap` and `refAliases` for anchor tracking |
| **`.proof/` Watching** | `src/app/api/wiki/watch` + `src/stores/proof-store.ts` | ✗ NOT IMPLEMENTED | Only HTTP polling; no chokidar watch or SSE push today |
| **Activity API** | `src/app/api/agent/activity/route.ts` | ✓ Found | Aggregates sidecar events; `GET /api/agent/activity?limit=<int>&file=<path>` returns `{events, count}` |
| **Skill Delivery** | `src/app/api/agents/skill/route.ts` + MCP register | ✓ Found | Skills served from `agents/` dir; tokens delivered at MCP startup (env vars), NOT injected into live sessions |
| **Comment UI Props** | `src/components/editor/comment-pip.tsx` + `comment-thread.tsx` | ✓ Found | Accept `anchorKey` + `comments[]`; markdown uses `anchorRef`, text uses `lineAnchor` |
| **Suggestion UI Props** | `src/components/editor/suggestion-card.tsx` | ✓ Found | Accepts block `ref` only; positions via `top/left/width` |
| **Proof Store** | `src/stores/proof-store.ts` | ✓ Found | Maintains `byPath[path].{sidecar, snapshotRevision, lastEventId}`; `pollEvents()` via HTTP |
| **MCP File Tools** | `packages/wiki-viewer-mcp/src/index.ts` | ✓ Found | 7 tools: read_file, write_file, edit_file, list_directory, search, move_file, delete_file |
| **MCP Auth** | `packages/wiki-viewer-mcp/src/index.ts:70–90` | ✓ Found | Env vars: `WIKI_VIEWER_URL`, `WIKI_VIEWER_TOKEN`, `WIKI_VIEWER_AGENT_ID`, optional `WIKI_VIEWER_WORKSPACE` |
| **Guppi Tmux Injection** | `pkg/tmux/client.go`, `.omx/tmux-hook.json` | ✗ NOT FOUND | No external API; internal hook only; no `SendKeys()` method exposed |

---

## Blockers for Review Loop Implementation

1. **No external prompt injection endpoint in guppi**: Design calls for wiki-viewer to inject prompts into agent's tmux session. Currently, guppi's tmux-hook targets a fixed pane configured at startup, not injectable from external sources.

2. **`.proof/` directory not watched**: Changes to sidecars are persisted but not pushed to browser. Would need chokidar watch + SSE emitter.

3. **No `.review.md` sibling mechanism**: Design assumes agents write `.proof/<path>.review.md` sidecar files with suggestions. This file type/location is not yet defined or watched.

4. **Collab-state awareness is one-way**: MCP adapter checks state on read, but agents cannot UPDATE wiki-viewer's collab state. Wiki-viewer would need an API to receive agent feedback (e.g., "agent finished, safe to close review mode").
