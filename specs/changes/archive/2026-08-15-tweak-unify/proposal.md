# Tweak Unification: Change Proposal

Status: Approved

## Problem

The "Live Instruct" feature ships as two divergent implementations that live under a single "Instruct/Go" umbrella:

- Markdown and plain text: `src/components/editor/live-overlay.tsx`. It operates on a single block and fires the instruction immediately (one shot, no queue).
- HTML: `src/components/editor/web-tweak-overlay.tsx`. It gathers targets into a queue and dispatches them as one batch run.

Because the two paths were built independently, the code is inconsistent and the user experience differs depending on content kind. This split has produced 4 reported UX issues.

## Desired outcome

A single shared "Tweak" feature module with content-kind adapters (one for markdown, one for HTML) so that both surfaces share the same code path and present consistent behavior to the user.

## Scope

- Unify the two overlays into one shared module.
- Add gather, queue, and batch dispatch to the markdown path (bringing it in line with HTML).
- Rename the feature to "Tweak" everywhere it is user-facing.
- Fix the selection stacking bug (re-selecting the same target inflates the count).
- Add tooltips to the bubble-menu actions.
- Update `docs/ux-contracts.md` to match the unified behavior.

## Non-goals

- No auth or path-containment changes.
- No server protocol change beyond reusing the shared live store for the markdown batch path.
- Do not rename the comment "instruction" kind.

## Risks

- Destabilizing the already shipped HTML batch flow while refactoring it into the shared module.
- Dedup key correctness (choosing a stable target key per content kind).
- Presence honesty (the presence gate must reflect real state after the refactor).

## Acceptance criteria

- Markdown supports gather-then-Rewrite batch dispatch.
- The feature reads "Tweak" everywhere, with no user-facing "Instruct" or "Go" strings remaining.
- Re-selecting the same target does not inflate the queued count.
- A deselect/cancel path exists.
- The 3 bubble-menu actions carry clarifying tooltips.
- `docs/ux-contracts.md` is updated.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` are green.
