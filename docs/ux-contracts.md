# UX Contracts

Code is ground truth. This document is the checklist of what wiki-viewer's
user-facing surfaces **actually do today**, verified against source. It describes
observable behavior (triggers, outcomes, exact constants), not implementation
details, so it survives refactors. Undocumented behavior is invisible to
refactors and easy to break silently.

## Why this exists

A user-visible contract (a delay, a limit, a key name, a state transition) is
easy to break during unrelated work and hard to notice. Writing the contract
down turns "did we regress the loop?" into a diff against this file.

## How to use this

- **Before** changing anything user-facing, read the relevant section here.
- **After** the change, update the entry in the same change, not later.
- If code and this doc disagree, **code wins**. Fix the doc as part of the change.
- Read this file in full (or via `offset`/`limit`) before editing; never do a
  full rewrite from a possibly-truncated read. Edit by targeted replacement.

## Table of Contents

- [1. Live collaboration](#1-live-collaboration)
  - [1.1 Presence indicator](#11-presence-indicator)
  - [1.2 The Go loop (shared across surfaces)](#12-the-go-loop-shared-across-surfaces)
  - [1.3 Markdown targets: write-on-accept](#13-markdown-targets-write-on-accept)
  - [1.4 Web-tweak targets: write-on-accept](#14-web-tweak-targets-write-on-accept)
  - [1.5 One outstanding request per session](#15-one-outstanding-request-per-session)
  - [1.6 Agent approval and token rotation](#16-agent-approval-and-token-rotation)
- [2. Live inventory (routes, tools, constants)](#2-live-inventory-routes-tools-constants)
- [3. Non-goals / explicitly out of scope](#3-non-goals--explicitly-out-of-scope)
- [4. Known gaps](#4-known-gaps)

---

## 1. Live collaboration

Impeccable-style interactive editing, extended to markdown as well as rendered
HTML. The attending agent is the user's own chat session (via MCP tools or the
raw HTTP transport), not a separate daemon. The foundational invariant across
every surface: **Live is speculative until Accept; Accept is the only thing that
writes the file.**

### 1.1 Presence indicator

**Contract:** A single presence mark in the surface toolbar has two states.
**Solid** "● listening" means an agent is live for this session; the **Go**
button works. **Amber** "◌ no agent" means no agent is live; the Go button
becomes **Connect**. Presence is solid when either (a) the agent held or
refreshed a poll within `PRESENCE_TTL_MS` (8s), or (b) a request is in `working`
state that was picked up within `WORKING_PRESENCE_GRACE_MS` (90s). A merely
`pending` request with nobody polling does **not** show solid. A `working`
request whose agent crashed falls back to amber after the 90s grace. Presence is
refreshed on every held poll tick (~400ms), on every agent reply, and on every
markdown/web preview submission.

**Why it matters:** If presence lies solid while no agent is attending, **Go
queues into the void** and the user sees "nothing happened", the exact failure
class this system exists to prevent.

**Verification pointer:** `src/lib/proof/live/store.ts`,
`src/app/api/wiki/live/status/route.ts`, `src/components/editor/live-presence.tsx`

### 1.2 The Go loop (shared across surfaces)

**Contract:** The loop is identical on both surfaces: point at a **Target** →
optionally type an instruction → **Go** → the target enters **Generating** →
**2 to 5 Variants** appear in place → cycle with **‹ ›** → **Accept** one or
**Discard**. Accept commits the chosen variant verbatim; Discard leaves the file
byte-identical. Agent replies use the shared verbs; the poll is held open up to
`HOLD_MS` (25s) so delivery latency is near zero, and returns `{ type: "timeout" }`
otherwise. The poll response echoes `afterSeq` (the cursor) and `previewId` as
first-class fields on both delivered and timeout responses.

**Why it matters:** One vocabulary and one state machine across surfaces is what
makes markdown and HTML feel like one product; divergent review dialects break
the mental model.

**Verification pointer:** `src/app/api/agent/live/poll/route.ts`,
`src/components/editor/live-overlay.tsx`, `src/components/web-tweak/web-tweak-overlay.tsx`

### 1.3 Markdown targets: write-on-accept

**Contract:** The target is a rendered **block** (paragraph, heading, list item,
etc.), with an optional text selection inside it carried only as context, never
as the edit unit. The agent returns 2 to 5 markdown-string variants; the client
renders the selected variant into the block's slot as an **ephemeral preview**
without touching the file. Accept commits the exact variant string through the
single tier-2 write engine, gated on the block's `baseBlockHash`
(`sha256:<hex>`), computed server-side at request time. If the block changed on
disk since the request, Accept is refused (`BASE_DRIFT`) and the file keeps the
manual edit. `md-resolve` (accept/discard) is **human-only**; an agent bearer
token cannot reach it.

**Why it matters:** Write-on-accept keeps the file clean until the human
decides; server-side hashing avoids the `crypto.subtle` secure-context failure
on HTTP deployments; drift refusal prevents clobbering concurrent human edits.

**Verification pointer:** `src/lib/proof/live/md-proposal-store.ts`,
`src/app/api/wiki/live/md-request/route.ts`, `src/app/api/wiki/live/md-resolve/route.ts`,
`src/app/api/agent/live/md-preview/route.ts`

### 1.4 Web-tweak targets: write-on-accept

**Contract:** The target is a DOM element in a static-HTML, opaque-origin
preview, picked via a postMessage-only picker. The agent returns 2 to 5 variants
(single-target variants path) or one candidate; each variant carries a unique
`variantId`, data-only DOM preview ops (attribute/style/class changes via
allowlist; no scripts), and an immutable `candidateSourcePatch` plus `baseFiles`
hashes. Accept commits the bound candidate verbatim for the single target file,
refused on base-file drift. A variants reply with fewer than 2 or more than
`MAX_VARIANTS` (5), or with missing/duplicate `variantId`, is rejected
`INVALID_PARAM`. Node-app previews are out of scope (same-origin escape risk).

**Why it matters:** The opaque-origin + postMessage + data-only constraints are
the security boundary; relaxing any of them lets hostile page JS reach the
parent and commit unguarded writes.

**Verification pointer:** `src/lib/web-tweak/preview-store.ts`,
`src/app/api/wiki/web-tweak/request/route.ts`, `src/app/api/wiki/web-tweak/resolve/route.ts`,
`src/app/api/agent/live/web-preview/route.ts`

### 1.5 One outstanding request per session

**Contract:** A session may have at most one non-terminal `generate`/`steer`
request at a time; a second dispatch while one is outstanding returns `409` with
the outstanding request id. Accept/discard/exit are always allowed. An agent
reply of `done` resolves the request with outcome `completed` and immediately
frees the channel (the activity/audit provenance, if any, remains for optional later review and
does not hold the slot). A delivered-but-unreplied request is redelivered on
reconnect (idempotency-key replay).

**Why it matters:** Serialization is what makes whole-file drift guards adequate;
without it, concurrent block edits would need per-block preconditions. A
non-terminal `done` previously deadlocked the session.

**Verification pointer:** `src/lib/proof/live/store.ts`,
`src/app/api/agent/live/reply/route.ts`

### 1.6 Agent approval and token rotation

**Contract:** An agent registers (trust-on-first-use), the owner approves it in
the AI panel, and the agent picks up a one-shot bearer token. Approving a
registration whose agent id **already exists** mints a new token and invalidates
the old one. When this happens the same rotation notice ("Approving replaced the
existing token for `<id>`; the previous token is now invalid.") is shown at every
human touchpoint: the AI-panel approve toast (`toast.warning`), the approve API
response (`rotated: true`, `warning`), and the register CLI pickup output
(`⚠️ …`). Only SHA-256 token hashes are stored.

**Why it matters:** Silent rotation stranded operators with a token that 401'd
with no explanation; the notice makes the rotation explicit and consistent.

**Verification pointer:** `src/app/api/agent/admin/registrations/[regId]/approve/route.ts`,
`src/lib/proof/pending.ts`, `src/app/api/agent/register/[regId]/route.ts`,
`src/components/ai-panel/token-section.tsx`, `packages/wiki-viewer-mcp/src/register.ts`

## 2. Live inventory (routes, tools, constants)

### MCP tools (packages/wiki-viewer-mcp)

| Tool | Purpose |
|------|---------|
| `live_attach` | Register presence for the session; returns sessionId (idempotent per agent+workspace) |
| `live_poll` | Long-poll held up to 25s; returns next request (with `previewId`, `seq`, `afterSeq`) or timeout |
| `live_reply` | Report `working` / `done` / `error` / `stale` on a delivered request |
| `live_snapshot` | Read the target file's block snapshot |
| `live_submit_markdown` | Submit 2–5 markdown-string variants for a block proposal |
| `live_submit_web` | Submit web-tweak DOM preview ops + candidate patch (single, batch `itemPreviews[]`, or variants) |

### HTTP routes

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `POST /api/agent/live/attach` | agent | Attach / presence |
| `GET /api/agent/live/poll` | agent | Long-poll for next request |
| `POST /api/agent/live/reply` | agent | Request lifecycle status |
| `POST /api/agent/live/md-preview` | agent | Submit markdown variants |
| `POST /api/agent/live/web-preview` | agent | Submit web DOM preview + candidate |
| `POST /api/wiki/live/md-request` | human | Point at a block, dispatch |
| `GET /api/wiki/live/md-status` | human | Proposal state + variants |
| `POST /api/wiki/live/md-resolve` | human only | Accept / discard markdown proposal |
| `GET /api/wiki/live/status` | human | Presence + current turn |
| `POST /api/wiki/web-tweak/request` | human | Point at an element, dispatch |
| `GET /api/wiki/web-tweak/status` | human | Preview state |
| `POST /api/wiki/web-tweak/resolve` | human only | Accept / discard web preview |

### Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `PRESENCE_TTL_MS` | 8000 | Poll-freshness window for solid presence |
| `WORKING_PRESENCE_GRACE_MS` | 90000 | Max time a `working` request keeps presence solid without fresh activity |
| Poll `HOLD_MS` | 25000 | Long-poll hold duration |
| Poll `TICK_MS` | 400 | Presence refresh / pending check interval while holding |
| Variants (markdown + web) | 2–5 | Min 2, max `MAX_VARIANTS` (5) per reply |
| Outstanding requests / session | 1 | Non-terminal generate/steer at a time |

## 3. Non-goals / explicitly out of scope

Deliberate v1 absences (each is a contract; do not re-add without a decision):

- **Steer** (doc-level "make it all better") — deferred; would break the
  single-block variants-in-place preview model.
- **Batch instruction queue + run-review UI** — removed from the Live path in
  favor of write-on-accept variants.
- **Write-first activity/audit provenance review in the Live path** — activity-log provenance remain only
  as optional accepted-provenance, not a pending-review workflow.
- **Node-app / dynamic HTML web-tweak** — static-HTML opaque-origin only; a
  same-origin app iframe would let hostile page JS click Accept.
- **Multi-file web candidates**, markdown variants spanning multiple blocks, live
  knobs/sliders, freehand strokes, comments-as-instructions escalation.

## 4. Known gaps

This document currently covers **only the Live collaboration surface**. The rest
of wiki-viewer is not yet inventoried here and must not be assumed documented:

- File browser / wiki shell (tree, open, edit, save gate, `409 STALE_REVISION`)
- TipTap editor behaviors outside Live (comments, suggestions, activity/audit provenance popover)
- Auth / sign-in / allowlist / CSRF behaviors
- Public share links (`/api/share`) and password-protected unlock
- Git-aware features (branch, history, diff, read-only repo workspaces)
- App runner / app-proxy
- Search, uploads, assets, cabinets, embeds
- Settings / system config, workspaces registry, keyboard shortcuts

Close a gap only after tracing producers and consumers in source, then move it
into a numbered section above.
