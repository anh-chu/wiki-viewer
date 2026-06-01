# Agent Collaboration Protocol — Implementation Plan

**Status:** Ready to implement
**Target:** wiki-viewer one-shot build, no v2
**Audience:** An implementing agent with no prior context on this conversation

---

## 0. Read this first

You are implementing an HTTP collaboration protocol that lets remote AI agents read and edit markdown files in wiki-viewer, with full provenance tracking and human-in-the-loop comments / suggestions.

The design is intentionally **API-compatible with [Proof SDK](https://github.com/EveryInc/proof-sdk)** in spirit — same op vocabulary, same block-ref + revision model, same suggestion lifecycle. This is so the user's mental model of "what an agent can do" transfers from Proof (which they already use and like) to wiki-viewer (this project).

**Hard constraints:**

- Single-user, local-first. No multi-tenancy, no share links, no realtime CRDT.
- File on disk is the source of truth. Always.
- Provenance marks live **inline** in the markdown (`<proof-span>` HTML).
- Comments / threads / suggestions / event log / block-ref maps live in a **sidecar directory** (`.proof/`) next to the file.
- TipTap is the editor. Do not introduce Milkdown or swap editors.
- No new runtime dependencies are required. Use what's in `package.json`.
- Block-ref + revision is the only mutation contract. **No selectors, no quote-matching**, no fuzzy-anchor resolution.
- Suggestions exist (proof has them, user wants them). Comments exist with threaded replies.

**Don't build:**

- Yjs, Hocuspocus, WebSockets, realtime collab.
- Multiple humans editing concurrently.
- Share-token creation flows, hosted-style `POST /documents` to create slugs.
- A new editor. Keep TipTap.
- Auth UI beyond a single bearer-token env var + a "regenerate token" button.
- Anything in proof's `server/` outside the agent bridge surface (snapshots, milkdown-headless, projection guardrails, S3, sqlite).

---

## 1. Glossary

| Term                | Definition                                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File path**       | Relative path from `ROOT_DIR`. Acts as the document slug. URL-encoded in routes.                                                                                             |
| **Block**           | A top-level markdown element. Heading, paragraph, list, blockquote, code fence, table, hr, html block. Lists and tables are treated as a single block.                       |
| **Block ref**       | Stable string ID like `b7f2a1`. Persists across edits via the sidecar's ref map.                                                                                             |
| **Revision**        | Monotonic integer per file. Bumps on every successful mutation. Used for optimistic locking.                                                                                 |
| **Provenance span** | An inline `<proof-span>` HTML element wrapping AI-authored text, with `origin`, `basis`, `by`, `at`, `id` attributes. Lives in the markdown.                                 |
| **Comment**         | A discussion thread attached to a block ref. Lives in the sidecar. Has ordered turns (initial + replies).                                                                    |
| **Suggestion**      | A proposed edit on a block ref. Pending / accepted / rejected lifecycle. Lives in the sidecar until accepted (becomes a real block edit) or rejected (deleted from sidecar). |
| **Event**           | Immutable log entry. New events emitted on every state change. Polled by agents.                                                                                             |
| **Sidecar**         | `<ROOT_DIR>/.proof/<file-path>.json` — one JSON file per markdown file, holds ref map, comments, suggestions, event log.                                                     |

---

## 2. Architectural overview

```
~/notes/                          ROOT_DIR
├── plan.md                       canonical content + inline <proof-span> marks
├── specs.md
├── subdir/
│   └── notes.md
└── .proof/
    ├── plan.md.json              sidecar for plan.md
    ├── specs.md.json
    └── subdir/
        └── notes.md.json
```

Sidecar path mirrors the source path under `.proof/`. Create directories as needed. `.proof/` is a single tree at the root, **not** a per-directory dotdir.

Mutation flow:

```
agent ── POST /api/agent/files/<path> ──► route handler
                                          │
                                          ├─ acquire per-file mutex
                                          ├─ load sidecar + file
                                          ├─ verify baseRevision matches
                                          ├─ apply ops (block.* mutate the .md,
                                          │             comment.* / suggestion.* mutate sidecar,
                                          │             suggestion.accept does both)
                                          ├─ write .md (rewraps proof-spans on inserts/replaces)
                                          ├─ write sidecar with new revision + appended events
                                          ├─ release mutex
                                          └─ return new snapshot
```

Read flow:

```
agent ── GET /api/agent/files/<path> ──► load .md → parse → assign refs → return blocks
agent ── GET /api/agent/events/<path>?after=N ──► tail sidecar's event log
```

Editor flow (browser):

```
chokidar watcher (already exists) → SSE → editor reloads file
                                       → re-parses inline <proof-span> via TipTap mark
                                       → renders gutter pips for comments (loaded from sidecar via separate REST call)
```

---

## 3. File-by-file scope

```
src/
├── app/api/agent/                   ← NEW
│   ├── files/[...path]/
│   │   ├── route.ts                  GET = snapshot, POST = apply ops
│   ├── events/[...path]/route.ts      GET poll events, POST ack
│   ├── sidecar/[...path]/route.ts    GET sidecar (for editor UI to load comments/suggestions)
│   └── settings/
│       ├── route.ts                  GET settings, POST regenerate token
│       └── token/route.ts            GET masked token + scope
├── lib/proof/                       ← NEW
│   ├── blocks.ts                     markdown → blocks parser, block → markdown emitter
│   ├── block-refs.ts                 ref generation, sidecar ref map updates
│   ├── proof-span.ts                 mark schema + serialization helpers (shared client/server)
│   ├── sidecar.ts                    read/write/migrate sidecar JSON
│   ├── ops-applier.ts                op execution against (markdown, sidecar) tuple
│   ├── event-bus.ts                  emit/poll/ack events on sidecar
│   ├── idempotency.ts                LRU keyed by Idempotency-Key
│   ├── mutex.ts                      per-file async mutex
│   ├── auth.ts                       bearer-token check middleware
│   └── types.ts                      Op, Block, Snapshot, Event, Comment, Suggestion
├── components/editor/
│   ├── extensions/
│   │   └── proof-span.ts             ← NEW   TipTap mark for <proof-span>
│   ├── proof-span-popover.tsx        ← NEW   Hover popover: origin, basis, Accept/Revert
│   ├── comment-pip.tsx               ← NEW   Gutter pip per commented block
│   ├── comment-thread.tsx            ← NEW   Thread popover w/ reply form
│   ├── suggestion-card.tsx           ← NEW   Inline pending-suggestion card with Accept/Reject
│   └── extensions.ts                 ← EDIT  Register ProofSpan mark
├── components/ai-panel/              ← NEW
│   ├── ai-panel.tsx                  Right-side drawer: connections + activity + token UI
│   ├── activity-row.tsx
│   └── token-section.tsx
├── stores/
│   ├── proof-store.ts                ← NEW   zustand: sidecar data per file, event tail cursor
│   └── ai-panel-store.ts             ← EDIT  Wire to real activity feed (replace stub)
├── lib/markdown/
│   └── to-markdown.ts                ← EDIT  Add turndown rule preserving <proof-span>
└── lib/proof-config.ts               ← NEW   Reads AGENT_BEARER_TOKEN, rate limits, etc.
```

Approx LoC: ~1900. One worker session.

---

## 4. Wire formats

### 4.1 The HTTP surface

All routes mount under `/api/agent/`. Authentication: `Authorization: Bearer <token>` header. If `AGENT_BEARER_TOKEN` env var is unset, accept any request from `127.0.0.1` and reject all others.

| Method | Route                                          | Purpose                                                    |
| ------ | ---------------------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/agent/files/<path>`                      | Snapshot: blocks + revision + meta                         |
| `POST` | `/api/agent/files/<path>`                      | Apply ops, return new snapshot                             |
| `GET`  | `/api/agent/events/<path>?after=<n>&limit=<n>` | Poll for events on this file                               |
| `POST` | `/api/agent/events/<path>`                     | Acknowledge events (for cleanup)                           |
| `GET`  | `/api/agent/sidecar/<path>`                    | Browser-side UI loads comments/suggestions                 |
| `GET`  | `/api/agent/settings`                          | Returns `{ rateLimit, hasToken, root }`                    |
| `POST` | `/api/agent/settings/token/regenerate`         | Mints a new token (writes to `~/.wiki-viewer/agent-token`) |

`<path>` uses Next.js catch-all `[...path]`. Segments are URL-encoded. Forbidden chars: `..`, leading `/`, anything resolving outside `ROOT_DIR`. Use the existing `safeRootPath` from `src/lib/root-dir.ts`.

### 4.2 Snapshot response

```json
{
  "path": "notes/plan.md",
  "revision": 47,
  "createdAt": "2026-05-29T10:00:00Z",
  "updatedAt": "2026-05-29T10:30:12Z",
  "fingerprint": "sha256:ab12...",
  "blocks": [
    { "ref": "b1a3f0", "type": "heading", "level": 1, "markdown": "# Q2 Plan" },
    {
      "ref": "b7f2c1",
      "type": "paragraph",
      "markdown": "Ship the rewrite by end of June."
    },
    { "ref": "b9c104", "type": "heading", "level": 2, "markdown": "## Risks" },
    { "ref": "be0123", "type": "bulletList", "markdown": "- tbd" }
  ],
  "comments": [
    {
      "id": "c4a1",
      "ref": "b7f2c1",
      "resolved": false,
      "createdAt": "2026-05-29T10:00:00Z",
      "turns": [
        {
          "by": "human",
          "text": "Why end of June?",
          "at": "2026-05-29T10:00:00Z"
        },
        {
          "by": "ai:claude",
          "text": "Because of the API freeze.",
          "at": "2026-05-29T10:00:14Z"
        }
      ]
    }
  ],
  "suggestions": [
    {
      "id": "s3b2",
      "ref": "b7f2c1",
      "status": "pending",
      "by": "ai:claude",
      "kind": "replace",
      "markdown": "Ship the rewrite by July 15.",
      "basis": "described",
      "basisDetail": "user mentioned slippage in chat",
      "createdAt": "2026-05-29T10:01:00Z"
    }
  ],
  "lastEventId": 47
}
```

`fingerprint` is sha256 of the raw .md file on disk, hex-encoded.

### 4.3 Block type vocabulary

Block parser must emit exactly one of these `type` values:

- `heading` (with `level: 1..6`)
- `paragraph`
- `bulletList`
- `orderedList`
- `taskList`
- `blockquote`
- `codeBlock` (with optional `lang`)
- `table`
- `hr`
- `html` (raw HTML block, e.g. embeds — kept verbatim)

A "block" is anything at the root of the markdown AST. Lists are atomic — a 5-item list is one block, not 5. This matches Proof's model and keeps refs stable when items shuffle inside a list.

### 4.4 Op vocabulary

Send via `POST /api/agent/files/<path>`. Body:

```json
{
  "baseRevision": 47,
  "by": "ai:claude",
  "ops": [ <op>, <op>, ... ]
}
```

Headers required on mutations:

- `Content-Type: application/json`
- `Idempotency-Key: <uuid>` (treat as required — return 400 if absent)
- `Authorization: Bearer <token>` (when token configured)

The ops, applied in order (atomic — all succeed or all roll back):

#### Block ops

```json
{ "type": "block.replace",     "ref": "b7f2c1", "markdown": "New content." }
{ "type": "block.insertAfter", "ref": "b7f2c1", "markdown": "## New section\n\nBody." }
{ "type": "block.insertBefore","ref": "b7f2c1", "markdown": "..." }
{ "type": "block.delete",      "ref": "b7f2c1" }
{ "type": "block.append",      "markdown": "..." }      // appended to file end, no ref
{ "type": "block.prepend",     "markdown": "..." }      // prepended to file start, no ref
```

`markdown` may contain multiple top-level blocks. They are inserted in order at the target position.

If the op originates from an AI agent (`by` starts with `ai:`), the **inserted text content is wrapped in a `<proof-span>` mark** automatically (see §5.3). The agent doesn't construct the span; the server does. Agents MAY supply additional metadata:

```json
{
  "type": "block.insertAfter",
  "ref": "b7f2c1",
  "markdown": "The team will focus on three pillars...",
  "basis": "described",
  "basisDetail": "user asked for opening paragraph",
  "inResponseTo": "c4a1"
}
```

`basis` ∈ `"described" | "inferred" | "suggested"`. Defaults to `"inferred"` for AI ops.

#### Comment ops

```json
{ "type": "comment.add",     "ref": "b7f2c1", "text": "Why end of June?" }
{ "type": "comment.reply",   "commentId": "c4a1", "text": "Because of API freeze." }
{ "type": "comment.resolve", "commentId": "c4a1" }
{ "type": "comment.reopen",  "commentId": "c4a1" }
```

`by` is taken from the request body's top-level `by` field.

#### Suggestion ops

```json
{
  "type": "suggestion.add",
  "ref": "b7f2c1",
  "kind": "replace",
  "markdown": "New content.",
  "basis": "described",
  "basisDetail": "user asked for clarity",
  "status": "pending"
}
```

- `kind` ∈ `"replace" | "insertAfter" | "insertBefore" | "delete"`
- `status` defaults to `"pending"`. If passed as `"accepted"`, the server applies the change immediately in the same mutation (equivalent to adding then accepting in one shot — Proof-compatible behaviour).

```json
{ "type": "suggestion.accept", "suggestionId": "s3b2" }
{ "type": "suggestion.reject", "suggestionId": "s3b2" }
```

On accept: apply the suggestion as the corresponding `block.*` op, then mark suggestion `accepted` in sidecar. On reject: mark `rejected` and prune from active list (move to `archivedSuggestions` array, keep for event history but don't include in default snapshot).

### 4.5 Response codes

| Status | Code field                                   | Meaning                                                                  |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------ |
| 200    | —                                            | Success, body is new snapshot                                            |
| 400    | `INVALID_PAYLOAD`                            | Malformed body / missing `Idempotency-Key`                               |
| 401    | `UNAUTHORIZED`                               | Bad / missing bearer token (when token configured)                       |
| 404    | `FILE_NOT_FOUND`                             | Path doesn't resolve under ROOT_DIR                                      |
| 409    | `STALE_REVISION`                             | `baseRevision` doesn't match current. Response includes fresh snapshot.  |
| 409    | `BLOCK_NOT_FOUND`                            | A block ref in an op no longer exists. Response includes fresh snapshot. |
| 409    | `COMMENT_NOT_FOUND` / `SUGGESTION_NOT_FOUND` | Same idea.                                                               |
| 422    | `INVALID_MARKDOWN`                           | Op's `markdown` field fails to parse cleanly                             |
| 429    | `RATE_LIMITED`                               | See §6.3                                                                 |
| 500    | `INTERNAL`                                   | Unexpected. Log to server.                                               |

`Idempotency-Key` replay: if the same key + same payload hash is seen within 5 minutes, return the cached response (same status code and body). If same key + different payload, return 409 with `IDEMPOTENCY_KEY_REUSED`.

### 4.6 Events

Every successful mutation emits one or more events appended to the sidecar's `events` array. Event IDs are monotonic per file (not global).

```json
{ "id": 48, "type": "block.replaced", "ref": "b7f2c1", "by": "ai:claude", "at": "...", "newRef": "b8f3d2" }
{ "id": 49, "type": "block.inserted", "after": "b7f2c1", "refs": ["b8f3d2", "b8f3d3"], "by": "ai:claude", "at": "..." }
{ "id": 50, "type": "block.deleted", "ref": "b9c104", "by": "human", "at": "..." }
{ "id": 51, "type": "comment.added", "commentId": "c4a1", "ref": "b7f2c1", "text": "...", "by": "human", "at": "..." }
{ "id": 52, "type": "comment.replied", "commentId": "c4a1", "text": "...", "by": "ai:claude", "at": "..." }
{ "id": 53, "type": "comment.resolved", "commentId": "c4a1", "by": "human", "at": "..." }
{ "id": 54, "type": "suggestion.added", "suggestionId": "s3b2", "by": "ai:claude", "at": "..." }
{ "id": 55, "type": "suggestion.accepted", "suggestionId": "s3b2", "by": "human", "at": "..." }
{ "id": 56, "type": "suggestion.rejected", "suggestionId": "s3b2", "by": "human", "at": "..." }
{ "id": 57, "type": "file.externallyEdited", "fingerprint": "sha256:...", "at": "..." }
{ "id": 58, "type": "span.accepted", "spanId": "p1", "by": "human", "at": "..." }
{ "id": 59, "type": "span.reverted", "spanId": "p1", "by": "human", "at": "..." }
```

`file.externallyEdited`: emitted when chokidar detects a file change that did NOT come from a mutation API call. This is how remote agents notice that the human edited in vim.

Poll: `GET /api/agent/events/<path>?after=47&limit=100`. Default limit 100, max 1000. Returns `{ "events": [...], "lastEventId": 59 }`.

Ack: `POST /api/agent/events/<path>` with body `{ "upToId": 59, "by": "ai:claude" }`. HTTP method dispatch: GET=poll, POST=ack.

> **Note:** Route paths restructured for Next 16 catch-all compliance; semantics unchanged. **Acks are purely advisory** — events are never deleted. The ack writes a `lastAck.<by>` cursor on the sidecar, for diagnostic purposes. This is intentional: events are a small append-only log, file sizes stay bounded by §6.5 trimming.

---

## 5. Detailed implementation

### 5.1 `src/lib/proof/types.ts`

```ts
export type BlockType =
  | "heading"
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "codeBlock"
  | "table"
  | "hr"
  | "html";

export interface Block {
  ref: string; // "b" + 6-hex
  type: BlockType;
  level?: number; // headings only
  lang?: string; // codeBlock only
  markdown: string; // canonical markdown for this block, trailing \n stripped
}

export interface ProvenanceMeta {
  origin: "human" | "ai";
  basis?: "described" | "inferred" | "suggested";
  basisDetail?: string;
  by?: string; // "ai:claude" or "human"
  at?: string; // ISO 8601
  spanId: string; // "p" + 4-hex
  inResponseTo?: string; // comment id
}

export interface CommentTurn {
  by: string; // "human" | "ai:claude"
  text: string;
  at: string;
}

export interface Comment {
  id: string; // "c" + 4-hex
  ref: string; // block ref it's attached to
  resolved: boolean;
  createdAt: string;
  turns: CommentTurn[];
}

export type SuggestionKind =
  | "replace"
  | "insertAfter"
  | "insertBefore"
  | "delete";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface Suggestion {
  id: string; // "s" + 4-hex
  ref: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  by: string;
  markdown?: string; // omitted for kind=delete
  basis?: ProvenanceMeta["basis"];
  basisDetail?: string;
  createdAt: string;
  resolvedAt?: string; // when accepted/rejected
  resolvedBy?: string;
}

export interface ProofEvent {
  id: number;
  type: string; // see §4.6 list
  at: string;
  by: string;
  [k: string]: unknown;
}

export interface Sidecar {
  schemaVersion: 1;
  path: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  // Map of block.ref → current text fingerprint (sha256 of block markdown, first 12 hex).
  // Used to detect external edits and to keep refs stable through round-trips.
  refMap: Record<string, { textHash: string; lastSeenAt: string }>;
  // History of ref renames. Old ref → new ref, kept for ONE generation.
  refAliases: Record<string, string>;
  comments: Comment[];
  suggestions: Suggestion[];
  archivedSuggestions: Suggestion[];
  events: ProofEvent[];
  nextEventId: number;
  lastAck: Record<string, number>; // by → eventId
  fingerprint: string; // last-known sha256 of the .md file
}

export type Op =
  | {
      type: "block.replace";
      ref: string;
      markdown: string;
      basis?: string;
      basisDetail?: string;
      inResponseTo?: string;
    }
  | {
      type: "block.insertAfter";
      ref: string;
      markdown: string;
      basis?: string;
      basisDetail?: string;
      inResponseTo?: string;
    }
  | {
      type: "block.insertBefore";
      ref: string;
      markdown: string;
      basis?: string;
      basisDetail?: string;
      inResponseTo?: string;
    }
  | { type: "block.delete"; ref: string }
  | {
      type: "block.append";
      markdown: string;
      basis?: string;
      basisDetail?: string;
      inResponseTo?: string;
    }
  | {
      type: "block.prepend";
      markdown: string;
      basis?: string;
      basisDetail?: string;
      inResponseTo?: string;
    }
  | { type: "comment.add"; ref: string; text: string }
  | { type: "comment.reply"; commentId: string; text: string }
  | { type: "comment.resolve"; commentId: string }
  | { type: "comment.reopen"; commentId: string }
  | {
      type: "suggestion.add";
      ref: string;
      kind: SuggestionKind;
      markdown?: string;
      basis?: string;
      basisDetail?: string;
      status?: SuggestionStatus;
    }
  | { type: "suggestion.accept"; suggestionId: string }
  | { type: "suggestion.reject"; suggestionId: string };

export interface Snapshot {
  path: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
  blocks: Block[];
  comments: Comment[]; // unresolved + resolved (separately by client)
  suggestions: Suggestion[]; // pending only by default
  lastEventId: number;
}
```

### 5.2 `src/lib/proof/blocks.ts` — markdown ↔ blocks

Reuse what's in `package.json`: `unified`, `remark-parse`, `remark-gfm`. **Do not add new deps.**

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Root, RootContent } from "mdast";

const PARSER = unified().use(remarkParse).use(remarkGfm);
const STRINGIFY = unified()
  .use(remarkStringify, {
    bullet: "-",
    fence: "`",
    fences: true,
    listItemIndent: "one",
    rule: "-",
    emphasis: "*",
    strong: "*",
  })
  .use(remarkGfm);

export function parseBlocks(markdown: string): RootContent[] {
  const tree = PARSER.parse(markdown) as Root;
  return tree.children;
}

export function blockToMarkdown(node: RootContent): string {
  const tree: Root = { type: "root", children: [node] };
  return (STRINGIFY.stringify(tree) as string).replace(/\n+$/, "");
}

export function blocksToMarkdown(nodes: RootContent[]): string {
  const tree: Root = { type: "root", children: nodes };
  return (STRINGIFY.stringify(tree) as string).replace(/\n+$/, "") + "\n";
}

export function blockType(node: RootContent): {
  type: BlockType;
  level?: number;
  lang?: string;
} {
  switch (node.type) {
    case "heading":
      return { type: "heading", level: (node as any).depth };
    case "paragraph":
      return { type: "paragraph" };
    case "list": {
      const n = node as any;
      if (
        n.children?.some(
          (li: any) => li.checked !== null && li.checked !== undefined,
        )
      )
        return { type: "taskList" };
      return { type: n.ordered ? "orderedList" : "bulletList" };
    }
    case "blockquote":
      return { type: "blockquote" };
    case "code":
      return { type: "codeBlock", lang: (node as any).lang ?? undefined };
    case "table":
      return { type: "table" };
    case "thematicBreak":
      return { type: "hr" };
    case "html":
      return { type: "html" };
    default:
      return { type: "paragraph" }; // fallback
  }
}
```

**Important roundtrip note:** `<proof-span>` elements inside paragraphs are parsed as raw HTML by remark and preserved in the AST. They survive `parse → stringify` unchanged. **Verify this with a unit test** (see §7).

### 5.3 `src/lib/proof/proof-span.ts` — provenance marks

Format (inline HTML, valid in CommonMark and GFM, ignored by markdown renderers, decorated by TipTap):

```html
<proof-span
  id="p4a1"
  origin="ai"
  basis="described"
  by="ai:claude"
  at="2026-05-29T10:00:00Z"
  in-response-to="c4a1"
  >The text the AI wrote.</proof-span
>
```

```ts
export interface SpanAttrs {
  spanId: string;
  origin: "ai" | "human";
  basis?: string;
  basisDetail?: string;
  by: string;
  at: string;
  inResponseTo?: string;
}

const SPAN_OPEN = /<proof-span\b([^>]*)>/g;

export function wrapAsProofSpan(markdown: string, attrs: SpanAttrs): string {
  // Find first non-whitespace leading content; wrap whole block's text content.
  // The simplest correct approach: stringify the block, then wrap the
  // *content portion* (everything after the leading markdown sigil) in a span.
  //
  // For paragraphs / list items: wrap the text content directly.
  // For headings: wrap text after the leading "#"s.
  // For code blocks, tables, hr: do NOT wrap — emit a separate sidecar-only
  //   provenance record (see §5.4 ProvenanceMeta on sidecar).
  //
  // The wrapper takes care of escaping " in attrs via &quot;.
  ...
}
```

Wrap rules (be conservative — if in doubt, don't wrap and record in sidecar instead):

| Block type                          | Wrap inline?                                            |
| ----------------------------------- | ------------------------------------------------------- |
| paragraph                           | yes, wrap text content                                  |
| heading                             | yes, wrap text after `#`s                               |
| bulletList / orderedList / taskList | yes, wrap each list item's text                         |
| blockquote                          | yes, wrap text content                                  |
| codeBlock                           | no — store provenance in sidecar `blockProvenance[ref]` |
| table                               | no — sidecar only                                       |
| hr                                  | no — sidecar only                                       |
| html                                | no — sidecar only                                       |

Add to `Sidecar` interface:

```ts
blockProvenance?: Record<string, SpanAttrs>; // for blocks we can't wrap inline
```

`unwrap` is straightforward: strip `<proof-span ...>` and `</proof-span>` from a markdown string for "Accept" (keep content, drop attribution mark). For "Revert" (delete content): the editor passes the span ID, server looks up the block, replaces span content with empty string, prunes empty paragraph if result is empty.

### 5.4 `src/lib/proof/block-refs.ts` — ref stability

Goal: when the agent has snapshot at revision 47 and posts `block.replace ref="b7f2c1"` based on it, the server must find that block even if the content has changed slightly (it shouldn't have, but defense-in-depth) and must give the new resulting block a stable new ref.

Algorithm (one-shot, no LSM, no complex CRDT):

1. **First parse** (no sidecar exists): for each block, compute `textHash = sha256(blockMarkdown).slice(0,12)`. Ref = `"b" + textHash.slice(0,6)`. Collision? Append `_<position>`.
2. **Subsequent parse** (sidecar exists with refMap): compute `textHash` per current block. For each block:
   - If `textHash` matches an existing ref's `textHash` → reuse that ref.
   - Else: this is a new block. Mint a new ref the same way as (1).
3. **After applying ops**: regenerate refMap from the new block list. For any old ref that was replaced/changed, record in `refAliases[oldRef] = newRef`. Aliases only persist ONE revision — they're flushed on the next mutation.

This gives "refs follow content when content barely changed" and "in-flight agent retries within one revision still resolve" without true content-addressable storage.

Block resolution for ops:

```ts
function resolveRef(
  sidecar: Sidecar,
  ref: string,
  currentRefs: Set<string>,
): string | null {
  if (currentRefs.has(ref)) return ref;
  if (sidecar.refAliases[ref] && currentRefs.has(sidecar.refAliases[ref])) {
    return sidecar.refAliases[ref];
  }
  return null;
}
```

### 5.5 `src/lib/proof/sidecar.ts`

```ts
export function sidecarPath(rootDir: string, mdPath: string): string {
  return path.join(rootDir, ".proof", mdPath + ".json");
}

export async function readSidecar(rootDir: string, mdPath: string): Promise<Sidecar | null> { ... }
export async function writeSidecar(rootDir: string, mdPath: string, sc: Sidecar): Promise<void> {
  await mkdir(path.dirname(sidecarPath(rootDir, mdPath)), { recursive: true });
  // Atomic-ish write: write to .tmp, fsync, rename.
  const tmp = sidecarPath(rootDir, mdPath) + ".tmp";
  await writeFile(tmp, JSON.stringify(sc, null, 2), "utf-8");
  await rename(tmp, sidecarPath(rootDir, mdPath));
}
export function emptySidecar(mdPath: string): Sidecar { ... }
```

Schema migrations: keep `schemaVersion: 1`. On read, if a different version → fail loudly (not silently). One-shot project, accept the constraint.

### 5.6 `src/lib/proof/ops-applier.ts` — the heart

Single entry point:

```ts
export async function applyOps(args: {
  rootDir: string;
  mdPath: string;
  baseRevision: number;
  by: string;
  ops: Op[];
}): Promise<
  | { ok: true; snapshot: Snapshot; emittedEvents: ProofEvent[] }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      snapshot?: Snapshot;
    }
>;
```

Implementation outline (pseudo):

```
acquire perFileMutex(mdPath)
try:
  read .md from disk
  fingerprint = sha256(.md)
  sidecar = readSidecar() ?? emptySidecar(mdPath)

  if sidecar.fingerprint && sidecar.fingerprint !== fingerprint:
    // External edit happened. Re-parse blocks (refs auto-stabilize via §5.4),
    // emit "file.externallyEdited", bump revision, persist, then continue.

  blocks = parseBlocks(.md)
  assignedBlocks = assignRefs(blocks, sidecar)   // returns Block[] with refs

  if baseRevision !== sidecar.revision:
    return STALE_REVISION + freshSnapshot

  workingBlocks = [...assignedBlocks]
  workingSidecar = clone(sidecar)
  workingEvents = []

  for op of ops:
    apply op:
      block.*           → mutate workingBlocks, regen refs for changed/new, append events
      comment.*         → mutate workingSidecar.comments, append events
      suggestion.add    → push to workingSidecar.suggestions
                           if status === "accepted": apply as block.* in-place + log accepted
      suggestion.accept → look up suggestion, apply as block op, mark accepted
      suggestion.reject → move to archivedSuggestions, log rejected
    if op fails (ref not found etc.): rollback, return appropriate 409

  newMarkdown = blocksToMarkdown(workingBlocks)
  newFingerprint = sha256(newMarkdown)
  workingSidecar.revision += 1
  workingSidecar.updatedAt = now()
  workingSidecar.fingerprint = newFingerprint
  workingSidecar.refMap = recomputeRefMap(workingBlocks)
  workingSidecar.refAliases = collectedAliases   // from this op batch only
  workingSidecar.events.push(...workingEvents)
  workingSidecar.nextEventId += workingEvents.length

  writeFile(.md, newMarkdown)
  writeSidecar(workingSidecar)

  return { ok: true, snapshot, emittedEvents }
finally:
  release mutex
```

**Important: AI wrapping happens here**, not in routes. When applying `block.insertAfter` from an `ai:*` actor:

- Parse the op's `markdown` into block nodes
- For each text-bearing node, wrap text in a freshly-minted `<proof-span>` with attrs from the op (`origin: "ai"`, `basis`, `basisDetail`, `by`, `at`, `spanId`, `inResponseTo`)
- For non-wrappable block types (code, table, hr, html), record into `sidecar.blockProvenance[newRef]` instead
- Stringify back to markdown for insertion

When `by` is `"human"` (or any non-`ai:*` value), no wrap. Human edits are unmarked by default.

### 5.7 Routes — `src/app/api/agent/files/[...path]/route.ts`

```ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getRootDir, safeRootPath } from "@/lib/root-dir";
import { checkAuth } from "@/lib/proof/auth";
import { applyOps } from "@/lib/proof/ops-applier";
import { readSnapshot } from "@/lib/proof/ops-applier"; // pure read variant
import { idempotency } from "@/lib/proof/idempotency";

export async function GET(
  req: Request,
  { params }: { params: { path: string[] } },
) {
  const auth = checkAuth(req);
  if (!auth.ok)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const rel = params.path.map(decodeURIComponent).join("/");
  const abs = safeRootPath(rel);
  if (!abs)
    return NextResponse.json({ error: "INVALID_PATH" }, { status: 400 });

  const snap = await readSnapshot(getRootDir()!, rel);
  if (!snap)
    return NextResponse.json({ error: "FILE_NOT_FOUND" }, { status: 404 });
  return NextResponse.json(snap);
}

export async function POST(req: Request, { params }) {
  const auth = checkAuth(req);
  if (!auth.ok)
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const idemKey = req.headers.get("idempotency-key");
  if (!idemKey)
    return NextResponse.json(
      { error: "INVALID_PAYLOAD", message: "Idempotency-Key required" },
      { status: 400 },
    );

  const body = await req.json();
  const rel = params.path.map(decodeURIComponent).join("/");
  const payloadHash = sha256(JSON.stringify({ rel, body }));

  const cached = idempotency.get(idemKey);
  if (cached) {
    if (cached.payloadHash !== payloadHash) {
      return NextResponse.json(
        { error: "IDEMPOTENCY_KEY_REUSED" },
        { status: 409 },
      );
    }
    return new NextResponse(cached.body, {
      status: cached.status,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await applyOps({
    rootDir: getRootDir()!,
    mdPath: rel,
    baseRevision: body.baseRevision,
    by: body.by,
    ops: body.ops,
  });

  const status = result.ok ? 200 : result.status;
  const respBody = JSON.stringify(
    result.ok
      ? result.snapshot
      : {
          error: result.code,
          message: result.message,
          snapshot: result.snapshot,
        },
  );
  idempotency.set(idemKey, { payloadHash, status, body: respBody });

  return new NextResponse(respBody, {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

Events route: `src/app/api/agent/events/[...path]/route.ts` — GET polls `sidecar.events.filter(e => e.id > after).slice(0, limit)`; POST bumps `sidecar.lastAck[by] = upToId` and persists. (Route paths restructured for Next 16 catch-all compliance; semantics unchanged.)

### 5.8 `src/lib/proof/auth.ts`

```ts
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TOKEN_PATH = path.join(os.homedir(), ".wiki-viewer", "agent-token");

function configuredToken(): string | null {
  if (process.env.AGENT_BEARER_TOKEN) return process.env.AGENT_BEARER_TOKEN;
  try {
    if (existsSync(TOKEN_PATH))
      return readFileSync(TOKEN_PATH, "utf-8").trim() || null;
  } catch {}
  return null;
}

export function checkAuth(
  req: Request,
): { ok: true; localhost: boolean } | { ok: false } {
  const token = configuredToken();

  // Inspect client origin. Trust X-Forwarded-For only if explicitly behind a proxy we control.
  // For localhost: check Host header is localhost / 127.0.0.1 / ::1.
  const host = req.headers.get("host") ?? "";
  const isLocal =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  if (!token) {
    // No token configured. Allow only local requests.
    return isLocal ? { ok: true, localhost: true } : { ok: false };
  }

  const auth = req.headers.get("authorization") ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (presented && timingSafeEqualStr(presented, token)) {
    return { ok: true, localhost: isLocal };
  }
  return { ok: false };
}
```

`timingSafeEqualStr`: pad both to equal length, use Node `crypto.timingSafeEqual`.

### 5.9 `src/lib/proof/idempotency.ts`

```ts
// Tiny in-memory LRU. Lives for process lifetime. Acceptable: idempotency
// guards retries within seconds, not days.
const MAX = 1000;
const TTL_MS = 5 * 60 * 1000;

interface Entry {
  payloadHash: string;
  status: number;
  body: string;
  expiresAt: number;
}
const store = new Map<string, Entry>();

export const idempotency = {
  get(key: string): Entry | null {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      store.delete(key);
      return null;
    }
    return e;
  },
  set(key: string, value: Omit<Entry, "expiresAt">): void {
    if (store.size >= MAX) {
      const first = store.keys().next().value;
      if (first) store.delete(first);
    }
    store.set(key, { ...value, expiresAt: Date.now() + TTL_MS });
  },
};
```

### 5.10 `src/lib/proof/mutex.ts`

```ts
const locks = new Map<string, Promise<void>>();

export async function withFileMutex<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  while (locks.has(path)) await locks.get(path);
  let release!: () => void;
  const p = new Promise<void>((r) => {
    release = r;
  });
  locks.set(path, p);
  try {
    return await fn();
  } finally {
    locks.delete(path);
    release();
  }
}
```

### 5.11 Browser side — TipTap mark `src/components/editor/extensions/proof-span.ts`

```ts
import { Mark, mergeAttributes } from "@tiptap/core";

export const ProofSpan = Mark.create({
  name: "proofSpan",
  priority: 900,
  inclusive: false,
  keepOnSplit: false,

  addAttributes() {
    return {
      spanId: {
        default: null,
        parseHTML: (el) => el.getAttribute("id"),
        renderHTML: (a) => ({ id: a.spanId }),
      },
      origin: {
        default: "ai",
        parseHTML: (el) => el.getAttribute("origin"),
        renderHTML: (a) => ({ origin: a.origin }),
      },
      basis: {
        default: null,
        parseHTML: (el) => el.getAttribute("basis"),
        renderHTML: (a) => ({ basis: a.basis }),
      },
      basisDetail: {
        default: null,
        parseHTML: (el) => el.getAttribute("basis-detail"),
        renderHTML: (a) => ({ "basis-detail": a.basisDetail }),
      },
      by: {
        default: null,
        parseHTML: (el) => el.getAttribute("by"),
        renderHTML: (a) => ({ by: a.by }),
      },
      at: {
        default: null,
        parseHTML: (el) => el.getAttribute("at"),
        renderHTML: (a) => ({ at: a.at }),
      },
      inResponseTo: {
        default: null,
        parseHTML: (el) => el.getAttribute("in-response-to"),
        renderHTML: (a) => ({ "in-response-to": a.inResponseTo }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "proof-span" }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "proof-span",
      mergeAttributes(HTMLAttributes, { class: "proof-span" }),
      0,
    ];
  },
});
```

CSS in `globals.css`:

```css
proof-span.proof-span,
.proof-span {
  background: linear-gradient(
    to right,
    rgba(165, 180, 252, 0.08),
    rgba(165, 180, 252, 0)
  );
  border-left: 2px solid rgb(165, 180, 252);
  padding-left: 4px;
  border-radius: 2px;
  cursor: pointer;
  transition: background 120ms ease;
}
proof-span.proof-span[origin="human"] {
  border-left-color: rgb(110, 231, 183);
  background: linear-gradient(
    to right,
    rgba(110, 231, 183, 0.08),
    rgba(110, 231, 183, 0)
  );
}
proof-span.proof-span:hover {
  background: linear-gradient(
    to right,
    rgba(165, 180, 252, 0.18),
    rgba(165, 180, 252, 0.04)
  );
}
.dark proof-span.proof-span {
  background: linear-gradient(
    to right,
    rgba(165, 180, 252, 0.14),
    rgba(165, 180, 252, 0)
  );
}
```

### 5.12 Turndown rule — `src/lib/markdown/to-markdown.ts` (EDIT)

Add a turndown rule preserving `<proof-span>` with attrs (similar to existing `styledSpan` rule):

```ts
turndown.addRule("proofSpan", {
  filter: (node) => node.nodeName === "PROOF-SPAN",
  replacement: (content, node) => {
    const el = node as HTMLElement;
    const attrs: string[] = [];
    for (const a of Array.from(el.attributes)) {
      attrs.push(`${a.name}="${a.value.replace(/"/g, "&quot;")}"`);
    }
    return `<proof-span${attrs.length ? " " + attrs.join(" ") : ""}>${content}</proof-span>`;
  },
});
```

Also: lowercase `<proof-span>` is preserved through DOM uppercasing (`nodeName === "PROOF-SPAN"` because DOM uppercases). Verify with a test.

### 5.13 Editor UI

#### `proof-span-popover.tsx`

On hover over a `.proof-span` element, show a small floating card:

```
┌────────────────────────────────────┐
│ ai:claude · described · 12s ago    │
│ "user asked for opening paragraph" │
│                                    │
│ [Accept]   [Revert]   [Comment]    │
└────────────────────────────────────┘
```

- Accept → POST to a special internal endpoint that strips the span from current file (server unwraps and rewrites .md, emits `span.accepted` event)
- Revert → same endpoint with action=revert (deletes the wrapped content)
- Comment → opens `comment-thread.tsx` in "new comment" mode anchored to the parent block

Use a dedicated internal route `POST /api/agent/internal/span` (body: `{ path, spanId, action: "accept"|"revert" }`). Only accept localhost requests on this route (it's UI-only, not part of the agent surface).

#### `comment-pip.tsx` + `comment-thread.tsx`

Margin pip rendered via a TipTap decoration plugin. Reads `useProofStore` for comments by ref. State pip icon based on:

- ● dot (filled) — open thread, last turn is AI
- ○ ring — open thread, last turn is human
- ✓ check — resolved (faded)

Click pip → opens thread popover anchored to the block. Reply form at bottom. Resolve / Reopen buttons in header.

#### `suggestion-card.tsx`

Pending suggestion shown inline above/below its target block, depending on `kind`:

```
┌──────────────────────────────────────────┐
│ claude suggests replacing this block ▸   │
│                                          │
│ ─ current ──────────────────────────────  │
│ Ship the rewrite by end of June.         │
│                                          │
│ ─ proposed ─────────────────────────────  │
│ Ship the rewrite by July 15.             │
│                                          │
│ Reason: user mentioned slippage in chat  │
│                                          │
│ [Accept]   [Reject]                      │
└──────────────────────────────────────────┘
```

Renders via a TipTap decoration. Buttons hit `POST /api/agent/files/<path>` with `suggestion.accept` / `suggestion.reject`.

### 5.14 AI Panel — `src/components/ai-panel/ai-panel.tsx`

Right-side slide-in drawer (similar layout to existing dialog/popover patterns).

```
┌────────────────────────────────────┐
│ Agents                       ✕     │
├────────────────────────────────────┤
│ Bridge endpoint                    │
│   http://localhost:3000            │
│   [copy curl]                      │
│                                    │
│ Token                              │
│   ••••••••cf12     [show] [copy]   │
│   [regenerate]                     │
│                                    │
│ Active connections      (last 5m)  │
│   • ai:claude     12 ops / 3 msgs  │
│   • ai:cursor     (idle)           │
│                                    │
│ Recent activity                    │
│   plan.md                          │
│     claude replaced b7f2c1   12s   │
│     claude commented on b9c104  2m │
│   specs.md                         │
│     claude inserted section    8m  │
│                                    │
│ Open AGENTS.md guide ↗             │
└────────────────────────────────────┘
```

Data:

- Connections: derived from sidecar event timestamps in the last 5 minutes, grouped by `by`.
- Activity: paginated event tail across all sidecars (scan `.proof/`).
- Token: pulled from `/api/agent/settings`.

This is read-only v1. No chat UI. Wire `useAIPanelStore` to actually drive panel open/close.

### 5.15 Stores — `src/stores/proof-store.ts`

```ts
interface ProofState {
  byPath: Record<
    string,
    {
      sidecar: Sidecar | null;
      snapshotRevision: number;
      lastEventId: number;
    }
  >;
  loadSidecar(path: string): Promise<void>;
  applyEvent(path: string, e: ProofEvent): void;
  // For the editor, on focus / file open / SSE notification, refetch sidecar.
}
```

The chokidar SSE feed (existing) already broadcasts file changes. Subscribe in the editor: when our file changes, refetch sidecar via `GET /api/agent/sidecar/<path>`.

### 5.16 Settings UI

Minimal addition to existing settings (if any) or a new modal:

- Toggle: Allow remote agents (controls bind-to-host but most users will just `--host 0.0.0.0` from CLI)
- Token display + regenerate
- Rate limit (default 60 ops/min per file)
- List of recent agent identities seen (purely informational, derived from event log)

---

## 6. Edge cases and contract details

### 6.1 External edits (user edits in vim)

Detected via fingerprint mismatch on next mutation OR via chokidar (already running). When detected:

1. Re-parse blocks
2. Re-assign refs (preserving as many as possible via §5.4)
3. Bump revision (counts as a system mutation)
4. Emit `file.externallyEdited` event
5. Persist sidecar
6. For any block that was deleted by the external edit, related comments/suggestions stay with their now-orphan ref. They are still returned in snapshots with `"ref": "<orphan>"`. UI shows them in an "orphaned" panel.

### 6.2 Concurrent mutations

The per-file mutex (§5.10) serializes mutations. The revision check (§4.5 `STALE_REVISION`) catches the case where two agents both held revision N and one beat the other.

### 6.3 Rate limiting

In-memory token bucket per `by` value:

- Bucket size 60, refill 1 op/sec
- Apply to mutation ops only (block._ + comment._ + suggestion.\*), not snapshot GETs / event polls
- Hit limit → 429 with `Retry-After: <seconds>` header

### 6.4 Sidecar size management

Events grow unbounded. Trim policy:

- Keep last 1000 events per sidecar
- When trimming, retain ALL events newer than the oldest `lastAck.*` cursor, even if it exceeds 1000
- Trim on every 100th mutation to amortize

### 6.5 Path traversal

Use existing `safeRootPath` from `src/lib/root-dir.ts`. Reject any path resolving to a directory above root. Reject `.proof` itself as a content path (reserved).

### 6.6 Non-markdown files

Reject mutations on non-`.md` files. Snapshot also rejects. Path must end in `.md` or `.markdown`.

### 6.7 Span IDs survive edits

When `block.replace` is applied:

- Existing `<proof-span>` elements inside the old block content that are NOT changed should retain their IDs
- New content gets a fresh span if the op's `by` is ai
- This is approximate. If the agent passes wholesale-replaced markdown, the old spans are gone. That's fine.

### 6.8 Suggestion conflicts

If two pending suggestions target the same ref, both stay pending. Accepting one does NOT auto-reject the other — but accepting one bumps the revision and may invalidate the other's ref via aliasing. On accept of #1, #2 stays pending but its ref might be aliased. UI must handle: surface `suggestion.ref-stale` state.

Keep it simple: when applying `suggestion.accept`, also iterate other pending suggestions with same ref and mark them as `status: rejected` with `resolvedBy: "system"` and event `suggestion.rejected` (reason: superseded). Document this in code comments.

### 6.9 Markdown roundtrip fidelity

Wiki-viewer has a non-trivial roundtrip (turndown + custom rules for wiki-links, embeds, lucide icons, etc.). The agent protocol bypasses that: it operates directly on the raw markdown file, not on the TipTap HTML. The block parser uses remark only. **This means: the agent never sees the editor's HTML.** It sees raw markdown with raw `<proof-span>` tags.

When the editor saves a file (via existing PUT `/api/wiki/content`), the turndown rule (§5.12) ensures `<proof-span>` is preserved. Verify with an end-to-end test.

### 6.10 Wiki-links and proof-spans

`[[slug]]` syntax inside a proof-span is fine. Remark parses link before HTML wrapping; turndown emits wiki-link rule before proof-span rule (because turndown processes children first). Verify.

### 6.11 Empty file / new file

`GET` on missing file → 404. Agent cannot create files through this protocol (that's a separate concern). If you want create-via-agent: extend later. Not in scope.

### 6.12 Hot reload during dev

When source changes trigger Next reload, in-memory idempotency cache and mutex map are wiped. Acceptable. Disk state (sidecars) survives. Tests should not depend on cache.

---

## 7. Tests

Minimum suite (place in `src/tests/proof/`). No test framework dependency required if `package.json` doesn't already have one — use `node --test` (built-in since Node 18) and `node:assert`.

### 7.1 Unit: blocks.test.ts

- parse → stringify roundtrip preserves `<proof-span>` exactly
- list with checkboxes detected as `taskList`
- code block with lang preserved
- table preserved

### 7.2 Unit: block-refs.test.ts

- First parse assigns refs deterministically
- Re-parse with same content reuses refs
- Edit one block, others keep refs
- Insert a block in middle, others keep refs
- Aliases populated after replace, cleared after next mutation

### 7.3 Unit: proof-span.test.ts

- wrapAsProofSpan on paragraph wraps text content
- wrapAsProofSpan on heading wraps text after `#`s
- wrapAsProofSpan on code block returns content unchanged + records in sidecar
- Special chars in basisDetail escaped properly

### 7.4 Integration: ops-applier.test.ts

For each op type:

- Happy path: apply, verify resulting markdown + sidecar
- STALE_REVISION returned when baseRevision wrong
- BLOCK_NOT_FOUND returned for stale ref
- Idempotency: same key returns cached response

### 7.5 Integration: routes.test.ts

Use `next` dev server in a temp ROOT_DIR. Hit routes with fetch.

- GET snapshot of a real .md file
- POST insertAfter → verify file content changed
- Poll events → see new event
- Ack events → cursor advances

### 7.6 Roundtrip: editor-save.test.ts

- Create .md with `<proof-span>` inline
- Load through `markdownToHtml` → TipTap state
- Serialize back through `htmlToMarkdown`
- Verify the `<proof-span>` is byte-identical

Critical: this test catches the silent failure where Tiptap mangles the mark on save.

---

## 8. Implementation order

Sub-agent that picks this up: execute phases in order. Do not skip ahead. Each phase ends with a working green test set.

### Phase A — Foundation (no UI yet)

1. Create `src/lib/proof/types.ts`
2. Create `src/lib/proof/blocks.ts`, get tests green
3. Create `src/lib/proof/block-refs.ts`, get tests green
4. Create `src/lib/proof/proof-span.ts`, get tests green
5. Create `src/lib/proof/sidecar.ts`
6. Create `src/lib/proof/mutex.ts`, `idempotency.ts`, `auth.ts`
7. Create `src/lib/proof/ops-applier.ts`, get tests green
8. Add `<proof-span>` turndown rule in `src/lib/markdown/to-markdown.ts`

**Acceptance:** All Phase A tests pass. No HTTP yet. No UI yet.

### Phase B — HTTP surface

1. Create `src/app/api/agent/files/[...path]/route.ts` (GET + POST)
2. Create `src/app/api/agent/events/[...path]/route.ts` (GET=poll, POST=ack)
3. Create `src/app/api/agent/sidecar/[...path]/route.ts`
4. Create `src/app/api/agent/settings/route.ts` + `settings/token/regenerate/route.ts`
5. Create `src/app/api/agent/internal/span/route.ts` (accept/revert)

**Acceptance:** Integration tests pass. `curl` workflow from §10 works.

### Phase C — Editor wiring

1. Create `src/components/editor/extensions/proof-span.ts` TipTap mark
2. Register in `extensions.ts`
3. Add CSS in `globals.css`
4. Create `src/stores/proof-store.ts`
5. Update editor to load sidecar on file open, subscribe to chokidar SSE for sidecar refresh
6. Create `proof-span-popover.tsx` (Accept / Revert / Comment)

**Acceptance:** Load a .md with `<proof-span>` inline → see decoration. Hover → popover works. Accept removes mark.

### Phase D — Comments

1. Create comment pip decoration plugin
2. Create `comment-thread.tsx`
3. Create comment composer (for human-initiated comments)
4. Wire to `POST /api/agent/files/<path>` with `comment.add` / `comment.reply` / `comment.resolve`

**Acceptance:** Human can create a comment on a block. Agent reply (simulated via curl) appears. Resolve works.

### Phase E — Suggestions

1. Create `suggestion-card.tsx` decoration
2. Wire Accept / Reject buttons

**Acceptance:** Agent POSTs `suggestion.add`. Card appears inline. Accept → block content changes, card disappears, event emitted.

### Phase F — AI Panel

1. Create `ai-panel.tsx` + sub-components
2. Update `ai-panel-store.ts` (remove stub, wire to data)
3. Add panel trigger button to layout header
4. Build activity aggregator (scans `.proof/` for recent events)

**Acceptance:** Panel opens, shows token, shows connections, shows recent activity. Copy-curl button works.

### Phase G — Polish

1. Rate limiting in middleware
2. Sidecar size trimming
3. Settings UI
4. README updates: agent protocol section
5. Manual smoke test of full flow (see §10)

**Acceptance:** §10 smoke test passes end-to-end.

---

## 9. Code style guardrails

- TypeScript strict mode. No `any` except at boundaries with non-typed deps.
- Tabs for indentation (project convention — see existing files).
- Functions over classes. No inheritance hierarchies.
- Async/await, never raw `.then`.
- Error responses always `{ error: "CODE", message?: string }`. Never bare strings.
- All routes mark `export const runtime = "nodejs"` (filesystem access).
- No console.log in committed code. Use a logger or remove.
- No `// TODO` / `// FIXME` in committed code. File issues instead.
- No em-dashes in any user-facing copy or docs. Use commas / sentence restructuring (per user convention).
- No AI / agent attribution in commit messages or PR descriptions (per user convention).
- Test files mirror source layout under `src/tests/proof/`.

---

## 10. Smoke test (manual)

Run after Phase G. This is the acceptance ritual.

```bash
# 0. setup
export ROOT_DIR=/tmp/wiki-smoke
mkdir -p $ROOT_DIR
echo "# Plan\n\nShip the rewrite by June." > $ROOT_DIR/plan.md
pnpm dev

# 1. snapshot (no token, localhost)
curl -s http://localhost:3000/api/agent/files/plan.md | jq

# Expect: blocks[] with two refs, revision: 0, comments: [], suggestions: []

# 2. agent inserts a paragraph
REF=$(curl -s http://localhost:3000/api/agent/files/plan.md | jq -r '.blocks[1].ref')

curl -s -X POST http://localhost:3000/api/agent/files/plan.md \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{
    \"baseRevision\": 0,
    \"by\": \"ai:claude\",
    \"ops\": [
      { \"type\": \"block.insertAfter\", \"ref\": \"$REF\",
        \"markdown\": \"The team will focus on three pillars: infra, tooling, launch.\",
        \"basis\": \"described\",
        \"basisDetail\": \"user asked for opening\" }
    ]
  }" | jq

# Expect: revision: 1, new block in snapshot, file on disk has <proof-span> around inserted text

cat $ROOT_DIR/plan.md
# Expect:
# # Plan
#
# Ship the rewrite by June.
#
# <proof-span id="p..." origin="ai" basis="described" by="ai:claude" at="..." basis-detail="user asked for opening">The team will focus on three pillars: infra, tooling, launch.</proof-span>

# 3. browser: open http://localhost:3000, navigate to plan.md
#    expect: lavender left-border decoration on the inserted paragraph
#    hover → popover shows "ai:claude · described · just now" + Accept/Revert/Comment

# 4. human comment via UI (right-click block → Comment)
#    type: "Are launch and tooling overlapping?"

# 5. agent polls events
curl -s http://localhost:3000/api/agent/events/plan.md?after=0 | jq
# Expect: events array with the comment.added event

# 6. agent replies
COMMENT_ID=<from event>
curl -s -X POST http://localhost:3000/api/agent/files/plan.md \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{ \"baseRevision\": 1, \"by\": \"ai:claude\",
        \"ops\": [{ \"type\": \"comment.reply\", \"commentId\": \"$COMMENT_ID\", \"text\": \"No, tooling is internal-only.\" }] }"

# 7. browser: open thread on the block, see agent's reply

# 8. agent proposes a suggestion
curl -s -X POST http://localhost:3000/api/agent/files/plan.md \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{ \"baseRevision\": 2, \"by\": \"ai:claude\",
        \"ops\": [{ \"type\": \"suggestion.add\", \"ref\": \"$REF\",
                    \"kind\": \"replace\",
                    \"markdown\": \"Ship the rewrite by July 15.\",
                    \"basis\": \"described\",
                    \"basisDetail\": \"deadline slipped\" }] }"

# 9. browser: see inline suggestion card. Click Accept.
#    expect: block content changes, card disappears, file on disk updated

# 10. token flow
#     stop server, set AGENT_BEARER_TOKEN=test123, restart
#     curl without token → 401
#     curl with -H "Authorization: Bearer test123" → 200

# 11. external edit
#     while server running:
#       echo "appended line" >> $ROOT_DIR/plan.md
#     immediately:
#     curl /api/agent/events/plan.md?after=<last>
#     expect: file.externallyEdited event
```

If any step fails, fix before declaring done.

---

## 11. What to ask the user before starting

Before implementing, agent should re-confirm only these specifics:

1. The bearer-token storage path `~/.wiki-viewer/agent-token` is fine, OR prefer env-only?
2. The localhost-without-token default OK, OR token always required?
3. Rate limit default of 60 ops/min/agent OK, OR different?

Everything else: follow this plan as-written. Do not deviate from the API shape, op vocabulary, error codes, or sidecar schema. If a real blocker emerges during implementation, surface it as a question with concrete options rather than improvising.

---

## 12. Out of scope (do not build)

To prevent scope creep, the following are **explicitly out** even if they seem like natural additions:

- File create / rename / delete via agent protocol (use the existing `/api/wiki/*` for that)
- Multi-file ops (one file per request, period)
- Diff visualizer beyond the suggestion card's two-pane view
- @-mentions, agent-to-agent messaging
- Webhooks pushing to agent URLs (agents poll)
- Realtime cursors / presence indicators per agent in the editor body
- Persisting idempotency across server restarts
- Auth scopes beyond all-or-nothing
- Per-file ACLs
- Export / import of sidecars
- Migrations from / to Proof's hosted format

All of these can be added later as separate features without conflicting with this design.

---

## 13. Definition of done

- All phases A–G complete
- All tests in §7 green
- §10 smoke test passes end-to-end
- README updated with "Working with agents" section pointing at the agent protocol
- No console.logs, no TODOs, no commented-out code shipped
- Manual review by a `reviewer` agent run via `/feature` chain

When done: notify the user, paste the final smoke test output as evidence.
