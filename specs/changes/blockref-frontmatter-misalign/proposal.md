# blockRef misalignment: frontmatter blocks vs rendered DOM

## Problem (root cause of "agent does nothing")

Live markdown instructions were resolving to the WRONG block, so the agent
"successfully" edited a block that had nothing to change. Concretely, every test
targeted `bcb3f91` = the frontmatter `---` delimiter (block 0), which has no
em-dash, so "remove em-dash" was a verified no-op and the UI looked unchanged.

### Why

`resolveSelectionBlock()` in `src/components/editor/editor.tsx` maps a selection
to a block by **positional index** into `useProofStore...snapshotBlocks`:

```
const block = blocks[topIndex];   // topIndex = DOM child index
blockRef = block?.ref ?? ...
```

But the two sequences are not aligned:

- `snapshotBlocks` comes from `/api/agent/files` (tier-2 snapshot) and **includes
  YAML frontmatter as blocks** (block 0 = `---`, 1 = `title: ...`, 3 = `---`, ...).
- The rendered ProseMirror DOM renders `parsedViewingContent.body`, i.e.
  **frontmatter stripped** (editor.tsx ~line 713; frontmatter shown separately via
  `FrontmatterHeader`).

So DOM child `i` corresponds to snapshot block `i + N` where `N` = number of
frontmatter blocks. Index-based resolution (and the `data-block-ref` annotation
effect at ~line 438, which also does `children[i] ↔ snapshotBlocks[i]`) are both
shifted by `N`.

Two compounding defects:

1. **Positional offset:** frontmatter blocks in the snapshot are not rendered, so
   `children[i] ↔ snapshotBlocks[i]` is wrong by the frontmatter block count.
2. **Silent fallback to block 0:** when native-selection resolution fails in view
   mode, `topIndex` falls back to `0` (`idx >= 0 ? idx : 0`), which is the `---`
   frontmatter delimiter. A failed resolve should NOT silently target block 0.

## Desired outcome

Selecting a block and instructing the agent targets **that block's** true ref, so
the agent edit lands on the intended content and produces a visible activity/audit provenance +
review bar.

## Scope

- Fix block resolution + the `data-block-ref` annotation effect so DOM children
  map to the correct snapshot blocks despite stripped frontmatter.
- Fail closed (return null, no dispatch) when a selection can't be resolved to a
  real block, instead of defaulting to block 0.

## Non-goals

- No change to the tier-2 snapshot shape (keep frontmatter blocks in the API).
- No change to the write engine, live store, or agent runtime.
- No sub-block anchoring.

## Approach options (for implementer to choose)

- **A (align by skipping frontmatter):** compute `frontmatterBlockCount` from the
  snapshot (leading blocks until the frontmatter terminates) and offset the
  index map: DOM child `i` ↔ `snapshotBlocks[i + frontmatterBlockCount]`. Simple,
  but relies on correctly counting frontmatter blocks.
- **B (ref-native, preferred):** stop trusting positional index. Give each
  rendered top-level node a stable `data-block-ref` derived from a content match
  against the non-frontmatter snapshot blocks (in order), and resolve selection
  via `closest('[data-block-ref]')`. Removes index fragility entirely.

Prefer B if tractable; otherwise A with a robust frontmatter-block count.

## Acceptance criteria

- Selecting the H1 title block (which contains an em-dash) and instructing
  "remove em-dash" resolves to that block's ref, not `bcb3f91`.
- A failed/ambiguous selection dispatches nothing (no silent block-0 target).
- `data-block-ref` on rendered nodes matches the snapshot ref for the same
  visible content.
- Existing tests pass; add a regression test for frontmatter offset if feasible
  at the unit level.
