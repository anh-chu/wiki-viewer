# Design: collective agent review

## Overview

Turn the fire-and-forget, one-target agent call into **collect → send batch → review batch**,
sharing one workflow across Markdown and web, while keeping the two write engines separate.

Two annotation kinds share the existing anchoring machinery:

- **comment** — human discussion (existing behavior).
- **instruction** — an agent work order; accumulates into a per-file queue; dispatched as one
  **run**.

## Data model

### Markdown annotations (sidecar)

Reuse the existing `Comment` model and its anchoring/reanchor/stale machinery. Add annotation
kind + queue/run linkage as **additive, nullable** fields (Gap-1 precedent).

`src/lib/proof/types.ts`:

```
export type AnnotationKind = "comment" | "instruction";

export interface Comment {           // existing; extended
  id: string;
  ref?: string;
  lineAnchor?: LineAnchor;
  resolved: boolean;
  createdAt: string;
  turns: CommentTurn[];
  stale?: boolean;
  // NEW (all optional; absent => "comment" for legacy rows)
  kind?: AnnotationKind;             // "instruction" marks a work order
  instructionState?: "draft" | "queued" | "sent" | "answered"; // instruction lifecycle
  runId?: string;                    // the send run this instruction went out in
  fromCommentId?: string;           // backlink when escalated from a comment
}
```

Rationale: one store, one anchoring path (no duplicate subsystem), but `kind` is a required
*semantic type* to the user (two create actions), not a soft toggle. Legacy rows with no
`kind` render as comments.

### Web annotations

The web surface has no sidecar comment machinery. Web instructions live in the web-tweak
preview/live store as a small per-file instruction list keyed by workspace+path (new, small;
does not touch the Markdown sidecar). Same lifecycle fields (`draft/queued/sent/answered`,
`runId`).

### Run (the batch dispatch)

A **run** is one agent dispatch carrying N instruction items. Represent it on the existing
live request:

`src/lib/proof/live/store.ts`:

- Add request kind `generate.batch` (Markdown) and reuse `web.tweak` batching for web, OR
  keep `kind: "generate"` and add an `items` payload. Chosen: **add `items` to the request**
  so one row = one run.

```
export interface LiveInstructionItem {
  instructionId: string;   // annotation id
  blockRef: string | null; // markdown block or web selector target
  baseRevision: number | null;
  instruction: string;
  selectionText?: string | null;
}

export interface LiveRequest {        // extended
  ...
  items: LiveInstructionItem[] | null; // NEW: batch payload; null for legacy single requests
  runId: string | null;                // NEW: correlation id returned on results
}
```

The single-instruction fields (`instruction`, `blockRef`, `baseRevision`) stay for backward
compatibility and for control kinds; batch runs populate `items` + `runId`.

The **one-outstanding-request-per-session** invariant is unchanged: a run is still one
request row.

## Correlation (run id → changes)

- On send, generate `runId` (e.g. `run:<8hex>`) and stamp it on the request and on each
  queued instruction (`instruction.runId`).
- Markdown: the agent's tier-2 ops already carry `inResponseTo`. Extend the request's
  idempotency/correlation so proof-spans produced for this run carry the `runId` (via the
  existing `SpanAttrs` provenance). The editor groups proof-spans by `runId` to offer
  "Accept run / Discard run".
- Web: the preview transaction already binds a `previewId`; associate `previewId` with
  `runId` so the overlay reviews the whole run.

## Write paths (unchanged engines)

- **Markdown**: agent applies ops through existing `POST /api/agent/files` → `applyOps`
  (`ops-applier.ts:457`). Each op keeps baseRevision preflight and STALE_REVISION semantics.
  Batch accept = accept all proof-spans tagged with `runId`; batch discard = revert them.
  All-or-nothing is enforced at the review layer (accept each tagged span; if any fails,
  surface and stop — v1 keeps the simple path).
- **Web**: agent replies via existing `web-preview` route with the candidate patch bound to
  the run's `previewId`; accept commits through existing `commitCandidate` (single-file v1);
  discard invalidates.

No new write engine. Line-review gate: nothing writes document bytes or provenance outside
these two paths.

## API surface

### Human-facing

- `POST /api/wiki/live/request` — extend to accept `items[]` + return `runId` for a batch
  `generate` dispatch. Rejects with 409 if a run is already outstanding. Existing
  single-instruction body still accepted (legacy/compat).
- `GET /api/wiki/live/status` — already returns attached + last request; add `runId` and item
  count so the queue/review UI can render.
- Web already has `POST /api/wiki/web-tweak/request` and `/resolve`; extend request to carry
  `items[]` + `runId`; resolve stays per-run (accept/discard).

The instruction *queue itself* (draft instructions not yet sent) is client-side state backed
by the sidecar (Markdown) or the web instruction list; only **send** hits the live channel.

### Agent-facing

- `GET /api/agent/live/poll` returns the request including `items[]` + `runId`.
- Agent handler processes items together, applies tier-2 ops for Markdown (or submits web
  preview), then `reply done`. Correlation/idempotency derived from `runId`/`requestId` at
  commit time (existing one-engine rule).

## UI

### Markdown editor

- Bubble menu / view-mode affordance: replace single "Ask agent" with **Comment** and
  **Instruct** actions.
  - `openCommentForSelection` (existing) stays for comments.
  - New `openInstructForSelection` creates a `kind:"instruction"` annotation (draft), no
    dispatch. Retire `AskAgentPopover`'s immediate-send; reuse a lighter instruction editor
    that writes a draft instruction.
- Comment card gains a **"Turn into an instruction"** action (creates instruction with
  `fromCommentId`).
- A file-level **queue bar**: "N instructions ready · Send to agent" → enumerated confirm
  dialog → dispatch run.
- After a run returns, proof-spans tagged with `runId` are grouped with **Accept run /
  Discard run** controls, alongside existing per-span accept/revert.

### Web tweak overlay

- Element picker pins an **instruction** to an element (draft), no dispatch.
- Same file-level queue bar + enumerated Send.
- Review the returned preview run with Accept run / Discard run (existing preview overlay,
  relabeled).

## Backward compatibility

- `kind` absent ⇒ comment. Legacy sidecars unchanged.
- `items`/`runId` null ⇒ legacy single request path still works.
- Frozen async `recover` path untouched; event schema additions are ignorable by old
  consumers.

## Testing

- Sidecar: instruction kind persists; legacy comment loads as comment; escalation creates
  linked instruction without mutating the comment.
- Live store: batch request stores `items[]` + `runId`; one-outstanding invariant holds;
  poll returns items; reply correlates by runId.
- Review: accept run accepts all tagged spans; discard reverts all; failure leaves no partial
  state.
- Web: instruction queue → single send → preview run → accept commits single-file candidate;
  discard invalidates.
- Rename: no "Ask agent" string in user-facing surfaces; verb is Instruct / Send to agent.
- Floor holds; add the above as new tests.

## Rejected alternatives

- **Audience toggle on one note** (model C-as-toggle): makes accidental execution too easy;
  rejected. Kind is a real type set at creation, escalation is explicit one-way.
- **Separate second annotation subsystem** (model B-as-duplicate-store): duplicates anchoring
  machinery on Markdown for one bit of meaning; rejected in favor of one store + `kind`.
- **Per-item partial accept**: reintroduces multi-file atomicity; deferred.
