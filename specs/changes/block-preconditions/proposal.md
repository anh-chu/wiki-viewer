# Block-level write preconditions (deferred)

Status: **deferred**. Not scheduled. This records a decision so the current
whole-file conflict model is not later rediscovered as a bug.

## Problem

Tier-2 markdown writes use a single whole-file precondition (`baseRevision`,
now an honest content clock after the "revision = content change" fix). This is
a coarse proxy for the precondition we actually care about: *is the block the
agent is editing still what it read?*

Consequences of the whole-file guard:

- Two agents editing **different** blocks of the same file conflict (false
  positive). One is rejected even though their edits do not overlap.
- The guard does not precisely protect the one real race (a human edits block X
  while an agent's instruction for block X is in flight); it approximates it via
  whole-file drift.

This is acceptable today only because live v1 serializes work: **one outstanding
request per session**, so concurrent multi-block edits cannot occur.

## What we did instead (shipped)

`revision` bumps only when file content changes (fingerprint differs).
Annotation-only ops (`comment.add/mark/resolve/reopen`, `suggestion.add/reject`)
no longer advance it. This fixed the live-dispatch stale loop (dispatching an
instruction wrote a comment + marked it sent, bumping the counter twice and
invalidating the agent's own baseRevision) without any API or wire-contract
change. `revision` is now a content version, functionally a hash with cheap
monotonic ordering.

Rejected alternatives:

- **Delete the integer, gate tier-2 on fingerprint/If-Match like tier-1.** Buys
  nothing over the fix above (same coarse whole-file behavior), and breaks the
  published `wiki-viewer-mcp` `baseRevision` wire contract plus the human
  editor-save gate and `X-Collab-Revision` header arithmetic. If the counter is
  ever removed, it rides this proposal's wire-version bump, not a standalone
  migration.

## Desired end-state (D)

Invariant: **preconditions match write scope.**

- Whole-document replacement (human editor save) keeps a **whole-file**
  precondition (fingerprint / content revision).
- Per-block content ops (`block.replace`, `block.delete`) carry
  `blockRef` + `baseBlockContentHash`; under the file lock, resolve the ref
  fresh and require the target block still hashes to `baseBlockContentHash`,
  else reject. Whole-file drift is permitted as long as every target-block
  precondition holds.
- Positional/structural ops (`insertAfter`/`insertBefore`/`append`/`prepend`,
  move/split/merge) are **not** purely per-block. They anchor to a neighbor or
  to the file. They take an anchor-block precondition where one exists, a
  file-level precondition where none does (append/prepend to file), and remain
  fail-closed until stronger structural semantics are designed.
- Multi-op batches validate **all** target preconditions before applying any
  change.

This makes multi-block concurrency correct instead of coarsely fail-closed. It
is a core-engine change (touches the applier, `resolveRef`/alias reconcile, the
wire contract, and client plumbing), so it is deliberately not built now.

Note: this is a granularity split among writers, all still funneling through the
single `applyOps` engine under one file lock. It is **not** a second commit
engine (the rejected "two preflight dialects" smell was about two engines).

## Hazards to address when built

- **Structural/positional ops** have no single content block to hash; define
  anchor-vs-file precondition per op type. Do not let hashing an anchor block
  reintroduce the false-positive we are removing.
- **refMap/alias reconcile interaction:** a `ref + hash` pair captured before an
  external edit can legitimately match after `reconcileSidecar` reassigns refs
  (content preserved through a move). Decide whether that match is correct
  acceptance; it interleaves with the frozen async `recover` path.
- **Duplicate identical block content** is not a hazard: `blockRef` supplies
  identity, the hash supplies content; together they are unambiguous.
- **Do not** substitute impeccable's exact-`originalText` matching as a shortcut;
  it is ambiguous with duplicate text and weak around structural edits. Per-block
  hash + ref is the stronger model.

## Trigger to build

Lift "one outstanding request per session," or ship multi-agent / concurrent
multi-block editing. Until then, the whole-file guard is sufficient and the
false-positive on unrelated-block concurrency is an accepted, documented
limitation.
