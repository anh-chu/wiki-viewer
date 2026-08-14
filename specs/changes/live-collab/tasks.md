# Tasks: Live agent collaboration

## Backend
- [x] Live store (`src/lib/proof/live/store.ts`): SQLite `live.db`, session + request
      tables, presence TTL, one-outstanding-per-session enqueue, deterministic ids.
- [x] Agent transport: `POST /api/agent/live/attach`, `GET /api/agent/live/poll`
      (long-poll, presence via held request), `POST /api/agent/live/reply`.
- [x] Human dispatch: `POST /api/wiki/live/request` (generate/steer/accept/discard,
      CSRF-checked), `GET /api/wiki/live/status`.
- [x] Correlation: poll event surfaces `idempotencyKey = live:<id>` and
      `inResponseTo = live:<id>` for the agent to carry into the Tier-2 edit. No new
      write path; commit stays `applyOps`.

## Frontend
- [x] `EditorBubbleMenu`: add "Ask agent" action (`onAskAgent`).
- [x] `AskAgentPopover`: instruction input, agent-attached indicator, dispatch to
      `/api/wiki/live/request`, stale/conflict/detached feedback.
- [x] `editor.tsx`: `openAskAgentForSelection` using existing `resolveSelectionBlock`,
      render popover, wire prop.

## Tests
- [x] `src/tests/proof/live-collab.test.ts` covering R1, R2/R3, R5, R6, R7, R8, R9, R10.

## Docs
- [x] `agents/wiki-viewer-skill/SKILL.md`: "Live collaboration" section (loop + rules).
- [x] proposal.md / requirements.md / design.md.

## Verification
- [x] `pnpm typecheck` clean.
- [x] `pnpm lint` clean.
- [x] `pnpm test` — 656 pass, floor 648 (8 new live-collab tests included).

## Deferred / out of scope (recorded, not built)
- R4 steer + R11 editor-affordance covered by wiring, not a dedicated automated test
  (steer reuses the same enqueue/poll path proven by R2/R8).
- Client-side agent runtime that actually attaches and edits (this change ships the
  server channel + human UI; the agent side is the skill contract in SKILL.md).
- Async `recover` policy untouched; live path relies on `applyOps`' built-in exact
  revision/ref checks. No deletion of proof machinery.
