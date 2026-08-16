# Tweak Unification: Requirements

Each requirement is stated as observable behavior with GIVEN/WHEN/THEN scenarios.

## R1 Markdown batch

Markdown and plain text ALWAYS use gather-then-Rewrite, consistent with HTML. There is no instant one-shot dispatch.

- GIVEN a user selects a block and types an instruction, WHEN they add it, THEN it is queued.
- WHEN they press Rewrite, THEN the whole queue dispatches as one run.

## R2 Naming

The feature is named "Tweak". The dispatch button reads "Rewrite" on markdown/text and "Apply" on HTML. No user-facing "Instruct" or "Go" strings remain.

- GIVEN any surface where the feature appears, WHEN the user reads labels, tooltips, or toggles, THEN they see "Tweak" (and "Rewrite" or "Apply" for dispatch), never "Instruct" or "Go".

## R3 Dedup and deselect

Re-selecting the same target updates the existing queued item instead of adding a duplicate, so the count stays correct. A per-item remove and a cancel/deselect path exist on both surfaces.

- GIVEN an item for target T is already queued, WHEN the user selects T again and adds a new instruction, THEN the existing queued item is updated and the count does not increase.
- GIVEN a queued item, WHEN the user removes it, THEN it leaves the queue.
- GIVEN an active targeting state, WHEN the user cancels or deselects, THEN the targeting clears without dispatching.

## R4 Tooltips

The three actions show helper text:

- Comment = discuss/annotate.
- Suggest = propose a human edit.
- Tweak = AI rewrites the selection live now.

- GIVEN the bubble menu is open, WHEN the user hovers each of the three actions, THEN the corresponding helper text is shown.

## Constraints

- The markdown batch reuses the shared live store and `POST /api/wiki/live/request` (no new route). Per-item accept/discard stays on the unchanged md-resolve route, preserving BASE_DRIFT semantics.
- `docs/ux-contracts.md` is updated in the same change.
