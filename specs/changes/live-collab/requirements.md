# Requirements: Live agent collaboration

Each requirement is observable behavior with GIVEN/WHEN/THEN scenarios.

## R1 — Agent attaches and holds presence

GIVEN a registered agent with a valid bearer token, `X-Agent-Id`, and `X-Workspace`
WHEN it `POST /api/agent/live/attach`
THEN a live session is created (or the existing open one reused) and `{ sessionId }` returned
AND while the agent holds `GET /api/agent/live/poll` open, the session's `agent_last_seen`
    is refreshed so the session reports `attached: true`.

## R2 — Human dispatch reaches the waiting agent quickly

GIVEN an attached agent holding a live poll
AND a human editing a Markdown file with a top-level block selected
WHEN the human submits an instruction via `POST /api/wiki/live/request`
    `{ path, blockRef, baseRevision, kind: "generate", instruction }`
THEN the held agent poll returns `{ type: "generate", request: { requestId, path, blockRef,
    baseRevision, instruction } }` within ~1s of the submission (not on a fixed slow interval).

## R3 — Agent edit lands as a proof-span through the existing engine, correlated

GIVEN a delivered `generate` request with id `<rid>`
WHEN the agent `POST /api/agent/files/<path>` with `Idempotency-Key: live:<rid>`,
    `baseRevision` equal to the request's, and an op carrying `inResponseTo: "live:<rid>"`
THEN the edit is committed by the existing `applyOps` path, wrapped in a `<proof-span>` whose
    `SpanAttrs.inResponseTo === "live:<rid>"`
AND no new/separate write path is used.

## R4 — Steer within the same session

GIVEN an open live session with a resolved-or-working prior turn
WHEN the human submits another `POST /api/wiki/live/request { kind: "steer", instruction }`
THEN the agent receives it on its next held poll as `{ type: "steer", ... }`.

## R5 — Accept / revert reported to the session

GIVEN a proof-span produced by a live request
WHEN the human accepts or reverts it through the existing editor proof UI and the client
    posts `POST /api/wiki/live/request { kind: "accept" | "discard" }`
THEN the corresponding `live_request` is marked `resolved` with
    `outcome = accepted | reverted`.

## R6 — Stale intent fails closed

GIVEN a `generate` request captured at `baseRevision = R`
AND the human manually edits the file so its revision becomes `R+1` before the agent commits
WHEN the agent commits with `baseRevision = R`
THEN `applyOps` returns `409 STALE_REVISION`, the agent replies `error`, and the
    `live_request` is marked `stale`
AND the document is NOT silently re-edited against `R+1`.

## R7 — Replay safety

GIVEN a `generate` request `<rid>` whose tier-2 edit already committed
AND the agent crashed before replying, then reconnects and re-POSTs the same edit
WHEN it reuses `Idempotency-Key: live:<rid>` with the identical payload
THEN the cached tier-2 response is returned and NO duplicate edit is produced.

## R8 — One outstanding request per session

GIVEN a session with a non-terminal (`pending`/`delivered`/`working`) request
WHEN a human submits another `generate` for that session
THEN the dispatch is rejected with a clear conflict status until the prior turn resolves.

## R9 — Presence timeout

GIVEN a session whose agent stopped polling longer than the lease TTL
WHEN the editor queries `GET /api/wiki/live/status`
THEN it reports `attached: false`.

## R10 — Auth and workspace isolation

GIVEN two workspaces
WHEN an agent attached to workspace A polls
THEN it never receives live requests enqueued for workspace B
AND all agent live routes reject requests failing `checkAuth` / `enforceScope`.

## R11 — Editor affordance

GIVEN the Markdown editor with a top-level block selected
WHEN the user opens the bubble menu
THEN an "Ask agent" action is present that opens an instruction popover and dispatches R2.

## Verification

- `pnpm test` (proof suite) with new tests in `src/tests/proof/` covering R1-R10 at the
  store + route level.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
- R11 verified by component wiring (bubble-menu action present, dispatch call shape correct).
