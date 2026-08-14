# Web tweak variants (step 2)

## Problem

Step 1 gives one target one candidate: instruct an element, the agent returns one
staged change, accept or discard. The impeccable-native differentiator is missing:
ask for options and pick the best. Today a human who wants alternatives must
re-instruct the same element repeatedly, losing the earlier attempt each time.

## Desired outcome

For a single web element, a human asks for options. The agent returns N candidate
changes in one reply. The human switches between them in-frame (each candidate's
DOM preview applied live to the iframe), then accepts exactly one. Accept commits
that candidate's source patch verbatim; the rest are discarded.

## Scope

- Web surface only (static-HTML opaque-origin viewer, same as step 1). Markdown
  variants are out of scope.
- One target, one instruction, N candidates. Not batch: variants and the step-1
  collective batch are separate flows.
- New live request kind `web.tweak.variants`. Existing `web.tweak` (single) and
  batch paths are untouched.
- Agent returns all candidates in one reply (`variants[]`). No incremental
  streaming of candidates.
- Agent decides the count; server caps it (`MAX_VARIANTS = 5`).
- Write-on-accept preserved: source is clean until the human accepts one variant.
  Accept reuses `commitCandidate` verbatim with the selected candidate's
  `candidateSourcePatch` + `baseFiles`.

## Non-goals

- Markdown variants (N proof-span candidates per block).
- Multi-element variants (variants over a batch run).
- Multi-file candidates per variant (v1 keeps the single-file commit invariant).
- Incremental / streaming candidate delivery.
- Persisting rejected variants after resolve.

## Risks

- **Wrong candidate committed.** Accept must commit the exact variant the human
  selected, by immutable `variantId`, not by re-synthesis or array index that
  could shift. Mitigation: select by `variantId`; commit that variant's stored
  candidate verbatim.
- **Base drift across variants.** Each variant carries its own `baseFiles`
  (all against the same base). Accept re-checks the selected variant's baseFiles
  on disk; BASE_DRIFT => nothing written, transaction invalidated.
- **Preview leakage between variants.** Switching must fully revert the previous
  variant's DOM ops before applying the next, or previews compound. Mitigation:
  picker `revert` before each `apply`, same undo-state machinery as step 1.
- **Count abuse.** Agent returns 50 candidates. Mitigation: server caps at
  MAX_VARIANTS, rejects over-cap replies.

## Acceptance criteria

1. A human can request variants for one element and receive N (2..MAX) candidates.
2. Switching a variant in-frame shows only that variant's DOM preview (no
   compounding).
3. Accept commits exactly the selected variant's source patch verbatim, iff its
   baseFiles still match; otherwise BASE_DRIFT and nothing is written.
4. Discard writes nothing and clears the preview.
5. Single-tweak and batch flows are unchanged (regression floor holds).
6. Every variant candidate is single-file, baseFiles-covered, and path-scoped to
   the agent, same as step 1.
