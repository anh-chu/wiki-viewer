# Proposal: Live agent collaboration

**Status:** Draft (implementing)
**Change name:** live-collab

## Problem

Agent collaboration in wiki-viewer is pull-based and stateless. An agent calls the HTTP
API when *it* decides to, applies an edit, and disconnects. There is no notion of a human
sitting in the editor right now with an agent attached and waiting. A person cannot point
at a specific block, say "shorten this," and get a response in the same breath.

The impeccable skill's live mode nails that UX for websites: a human selects a rendered
element, an already-attached agent receives the request over a held-open channel, responds
in seconds, and the human iterates (steer) or resolves (accept/discard) in one continuous
session. We want that interaction for wiki-viewer documents, starting with Markdown, without
importing impeccable's HTML/DOM/HMR machinery (which does not apply to a text editor whose
real render surface is TipTap over the true file).

## Desired outcome

A human editing a Markdown file can select a top-level block, ask an attached agent to act
on it with a freeform instruction, and see the agent's proposal appear as a normal
`<proof-span>` in TipTap within seconds, then accept or revert it. The agent stays attached
across the turn so the human can steer and iterate. This is the day-to-day primary mode of
agent collaboration.

## What we are actually emulating

Not "selection-scoped edits." The load-bearing combination is:

- **Selection** — the human points at a precise block; the agent's edit scope is bounded to it.
- **Presence** — the agent holds a long-poll open and is *already blocked waiting*, so human
  input wakes it immediately (semantically live, even though the transport is agent-initiated
  long-poll, not literal server push).
- **Live dispatch** — a human action in the editor pushes an event to that waiting agent now.
- **Iteration** — generate -> steer -> accept/discard is one continuous session, not unrelated
  HTTP calls.

The presence + live-dispatch + session-continuity control plane is genuinely new surface. It
sits *above* the existing mutation engine.

## Architecture decision: one commit engine, two preflight policies

We do **not** build a second write engine, and we do **not** rewrite the proof protocol.

- Both live and async edits flow through the **same canonical commit path** (block-ops ->
  `.md` + `.proof/` provenance -> lock -> audit -> idempotency). This is the invariant a
  reviewer enforces: live and async both call the same commit function.
- They differ only in a **preflight anchor policy**:
  - `exact` (live): exact `blockRef` + exact `baseRevision` + deterministic idempotency.
    Fail closed on any staleness. No fuzzy quote-matching, no moved-content search, no
    cross-revision block-ref recovery, no auto-rebase. "This request applies to exactly what
    the human selected at revision R; if that is no longer true, reject it."
  - `recover` (async/MCP): today's full defensive machinery (durable block-ref recovery,
    reconciliation) for stateless agents that may return hours later.

It becomes a forbidden "second writer" only if someone applies live edits outside the
canonical commit path. That is the line review enforces.

### Live is primary; async is niche

Unattended/remote agent edits (MCP, scheduled jobs) are a real but niche use case. Live is
much more useful day-to-day. Therefore:

- The `exact` (live) path is the default and where day-to-day effort and polish go.
- The `recover` (async) path is kept but not centered or grown. When the two policies would
  diverge on a design detail, the live path wins; async follows.
- Proof's convolution (block-ref indirection, sidecar recovery) is **retained and quarantined
  behind `anchorPolicy: "recover"`**, justified by the niche async user, never by the live UX.
- We do **not** delete async machinery now. Revisit shrinking `recover` only if the niche user
  disappears, and only after the live UX is proven and we can measure what actually fires.

## Scope

- New agent-facing live session/presence transport: attach (long-poll), event delivery, ACK,
  session + request lifecycle. Per-workspace namespaced, auth via existing bearer + `X-Agent-Id`
  + `X-Workspace`.
- Editor affordance: select a top-level block -> "Ask agent" -> freeform instruction ->
  dispatch a `generate` event; steer / accept / discard controls for the live turn.
- Live request correlation: tier-2 provenance records carry `{liveSessionId, liveRequestId}`.
- `exact` preflight policy wired into the existing commit path via `Idempotency-Key =
  live:<requestId>`.
- Minimal durable state in the existing SQLite db: live sessions + requests + delivery/ACK
  cursor. No new on-disk journal directory.

## Non-goals

- No impeccable helper server, no injected `live.js`, no HTML/CSS source localization, no HMR
  overlay, no variants, no scribble annotations.
- No arbitrary text/code selection (Markdown top-level blocks only for v1).
- No served-app / website collaboration.
- **No second write engine / no `applyLiveEdit()` outside the canonical commit path.**
- No rewrite of the proof protocol; no deletion of async recovery machinery.
- No multiple concurrent proposals per block; one outstanding request per session/block.
- No Yjs/CRDT/WebSockets; no multi-human concurrent editing.
- No fuzzy recovery, rebasing, or heroic stale-request recovery on the live path.

## Risks

1. **Stale human intent** (top correctness risk). Human selects block at R1, sends
   instruction, edits manually to R2, agent then processes. The agent must use the request's
   original `baseRevision`; on conflict the request is marked `stale`/`conflicted` and a new
   human request is required. Fail closed.
2. **Replayed requests -> duplicate edits.** Solved by deterministic
   `Idempotency-Key = live:<requestId>`; the agent must not invent a fresh key after recovery.
3. **Structural edits destroying block identity** (move/split/merge/delete while pending).
   Fail closed via revision + exact block-ref check; no fuzzy recovery in v1.
4. **Presence ambiguity** (working vs crashed vs network-gone vs forgot-to-reopen-poll).
   Handled with a small lease/timeout: timeout means disconnected; reconnect resumes from last
   ACK. Do not over-model presence.
5. **Accidentally creating another editor protocol.** Red flag if the live layer starts adding
   live snapshots / live accept-writer / live diff format. Those already belong to tier-2.

## Acceptance criteria

1. An agent can attach to a workspace live session over a held-open long-poll and receive a
   `generate` event pushed by a human editor action within ~1s of the action.
2. Selecting a top-level Markdown block in TipTap and submitting an instruction produces a
   tier-2 proof-span edit committed through the existing commit path, correlated with the live
   request id in provenance.
3. The human can steer (send a follow-up instruction in the same session) and the agent
   receives it on its next held poll.
4. Accept and revert of the resulting proof-span work through the existing editor UI and are
   reported back to the live session as `resolved{accepted|reverted}`.
5. A manual edit that changes the target block's revision before the agent commits causes the
   live request to fail closed as `stale`, not a silent re-interpretation.
6. Replaying the same live request (agent crash before ACK, then reconnect) does not produce a
   duplicate edit, verified via the deterministic idempotency key.
7. Live edits and existing async tier-2 edits both go through one commit function; there is no
   separate live filesystem-mutation path.
8. `pnpm test`, `pnpm typecheck`, `pnpm lint` pass; new behavior covered by tests in
   `src/tests/proof/`.
