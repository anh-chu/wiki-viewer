# Tasks: collective agent review

Ordered, checkable. Mark complete only after verification.

## Phase 1 — Data model (Markdown)

- [ ] T1. Add `AnnotationKind` + optional `kind`, `instructionState`, `runId`, `fromCommentId`
  to `Comment` in `src/lib/proof/types.ts`.
- [ ] T2. Sidecar read/write: persist and load new fields; legacy rows (no `kind`) load as
  comments. Add test.

## Phase 2 — Live store run model

- [ ] T3. Extend `LiveRequest` with `items: LiveInstructionItem[] | null` and
  `runId: string | null`; add columns (nullable) + migration-safe CREATE.
- [ ] T4. `enqueueRequest` accepts `items[]` + `runId`; keep single-instruction path. Preserve
  one-outstanding invariant (BEGIN IMMEDIATE). Add test.
- [ ] T5. Poll response + `toRequest` include `items` + `runId`.

## Phase 3 — Human API

- [ ] T6. `POST /api/wiki/live/request`: accept `items[]`, generate/echo `runId`, 409 on
  outstanding run. Legacy body still works.
- [ ] T7. `GET /api/wiki/live/status`: include `runId` + item count.

## Phase 4 — Markdown UI

- [ ] T8. Bubble menu + view-mode: split into **Comment** and **Instruct** actions; add
  `openInstructForSelection` that creates a draft instruction (no dispatch).
- [ ] T9. Replace `AskAgentPopover` immediate-send with a draft-instruction editor.
- [ ] T10. Comment card: **"Turn into an instruction"** action (sets `fromCommentId`).
- [ ] T11. File-level queue bar: "N instructions ready · Send to agent" + enumerated confirm
  dialog → POST run.
- [ ] T12. Group activity-log provenance by `runId`; add **Accept run / Discard run** controls (all-or-
  nothing) alongside existing per-span controls.

## Phase 5 — Web tweak parity

- [ ] T13. Per-file web instruction list (draft) keyed by workspace+path.
- [ ] T14. Picker pins an instruction to an element (no dispatch); same queue bar + Send.
- [ ] T15. Associate `previewId` with `runId`; overlay reviews the run (Accept run / Discard
  run), relabeled.

## Phase 6 — Rename + correlation

- [ ] T16. Retire "Ask agent"/"Tweak" verbs in user-facing UI → **Instruct / Send to agent**;
  matching review vocabulary both surfaces.
- [ ] T17. Thread `runId` into activity/audit provenance provenance (ActivityAttrs) so results correlate to the
  run and to each instruction item.

## Phase 7 — Agent runtime

- [ ] T18. `wiki-viewer-mcp` LiveClient/runLiveLoop: handle `items[]` batch requests; apply
  tier-2 ops per item; correlation/idempotency derived from `runId`/`requestId`.
- [ ] T19. Passthrough reference handler processes batch items.

## Phase 8 — Verify

- [ ] T20. Tests: kinds persist, escalation, batch enqueue, poll items, run correlation,
  accept/discard run all-or-nothing, web parity, no "Ask agent" string.
- [ ] T21. `pnpm typecheck`, `pnpm lint`, `pnpm test` (floor holds), mcp `npm test`.
- [ ] T22. reviewer pass on the diff (security, backward compat, no new write path).
