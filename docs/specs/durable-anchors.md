# Durable anchors: stop deriving annotation identity from content

Status: proposed
Branch: `feat/comments-rebuild`
Supersedes: nothing. Fixes forward from `4b6aa2a`.

## Problem statement

Annotating a document while editing it is unreliable in a way that no single bug
explains, because the unreliability is designed in.

Refs are content-derived: `"b" + sha256(blockMarkdown).slice(0,6)`. Every comment and
suggestion stores the `ref` of the block it is attached to. So an annotation's identity
is a **function of the text it annotates**. Edit that text and the identity is destroyed.

The system then tries to reconstruct the identity after the fact, through a chain of
heuristics, and each heuristic has leaked in production:

| Symptom seen live | Cause | Commit |
|---|---|---|
| suggestions vanish after typing | editing a block changes its ref; no alias recorded | `6f9fd72` |
| 12 suggestions on refs that no longer exist, `refAliases: {}` | the alias pass only matched content that MOVED | `6f9fd72` |
| every keystroke `409 Conflict` | the client dropped its own write's revision | `de295be` |
| base revision rolled backwards | a late GET assigned the revision unconditionally | `4b6aa2a` |
| comment highlights nothing | anchor resolution had no block-granular case | `e7292e3` |
| accepting an insertion deleted the paragraph | accept chain fell through to `block.delete` | `0e09f4a` |

These are real defects and the fixes are real. But they share one root: **identity is
derived from content, so every edit invalidates it and the system must guess it back.**
Google Docs does not have this class of bug because its anchors are opaque and durable —
an annotation points at a position in a document whose structure a single server owns.

Four separate mechanisms currently exist to patch the consequences:

1. `refAliases` — old ref to new ref, kept for ONE generation only.
2. `resolveRef` — consult aliases when the ref is gone.
3. `markOrphanedRefsStale` — mark what could not be resolved.
4. positional aliasing (added in `6f9fd72`) — guess the successor by slot.

A fifth, `survivesViaAlias`, exists only to stop deleting a paragraph from cancelling a
comment on a *different* identical paragraph. This is a lot of machinery dedicated to
recovering something that was never durably stored.

## What already exists (checked, not assumed)

The durable anchor is **already in the schema and already populated**. It is simply not
used as identity.

- `Comment.textAnchor` holds `{ start, end, selectedText, baseMarkdown }` — offsets, the
  exact selected text, and the block markdown the offsets were computed against. That is a
  complete W3C-style quote selector.
- `LineAnchor` holds `{ lineStart, lineEnd, textHash }` for the same recovery purpose.
- `selectedText` is **never searched for anywhere in the codebase.** It is validated at
  write time (`ops-applier.ts:865` requires the range to match the current markdown) and
  read for highlighting, but the recovery it was designed for was never written.
- `Suggestion` has no quote at all — only `ref` and a numeric `range`.

So the defect is narrower and more damning than "no durable anchor exists": the anchor was
built, is populated on comments, and then ignored. Everything resolves against `ref`, the
content-derived field, so the data that could have survived an edit is discarded and the
hash that cannot survive one is treated as identity.

This changes the work from *designing an anchor* to *promoting the anchor that is already
there and finishing it*. `Suggestion` needs the quote fields added; `Comment` needs its
existing ones to become the resolution path rather than a highlight hint.

## Solution

Make the existing quote data the **identity**, not a hint, and give it an opaque id so
annotations stop being named after their content.

- Annotations (comments and suggestions) reference an `anchorId` instead of a `ref`.
- Block refs remain, because they are the bridge between markdown and the document, and
  the `.md` stays the source of truth. But refs become an implementation detail of
  *resolving* an anchor, not the identity of the annotation.
- An anchor is resolved to a current `ref` + offset at read time. Editing the text under
  an anchor **moves the offset**, it does not invalidate the anchor.
- The four alias mechanisms collapse into anchor resolution. They are deleted, not
  layered under the new system.

This is a **migration**, not a rewrite: the `.md` file format, the tier-2 op vocabulary,
the block-ref bridge, and the acceptance/reject semantics all stay.

## User stories

- As the document owner, when I type inside a sentence that has a comment, the comment
  stays on that sentence and keeps its highlight, because it is anchored to the
  sentence, not to a hash of it.
- As the document owner, when I type in Suggesting mode, my run accumulates into one
  suggestion that persists across keystrokes, reloads, and external edits to the file.
- As the document owner, when I delete a paragraph, comments on *that* paragraph are
  marked lost, and comments on an identical paragraph elsewhere are untouched.
- As the document owner, when I edit the `.md` outside the app, annotations that still
  have matching text reattach; ones that do not are visibly marked, never silently
  dropped.
- As an agent, I can address an annotation by its opaque id and never need to know or
  guess a content hash.

## Implementation decisions

### Anchor record

Added to the sidecar. Kept deliberately small — this is a position pointer, not a
document model.

```
Anchor {
  id: string            // "a" + 6-hex, opaque, never content-derived
  ref: string           // last known block ref
  offset: number        // character offset within the block's canonical markdown
  length: number        // 0 for block-granular annotations
  quote: string         // the exact text at creation, the recovery fingerprint
  prefix: string        // ~32 chars before, for disambiguation
  suffix: string        // ~32 chars after
  createdAt: string
  updatedAt: string
}
```

`quote` / `prefix` / `suffix` follow the W3C Web Annotation Data Model's TextQuoteSelector
rather than inventing a scheme. That choice is deliberate: it is a published, well-tested
answer to "find this text again after the document changed", and it is the same approach
Hypothes.is and Google's own annotation tooling use.

### Resolution

`resolveAnchor(sidecar, anchor, currentBlocks)` returns
`{ ref, offset, length, status }` where status is one of:

- **exact** — the block still exists and `quote` matches at `offset`. No work.
- **moved** — the quote is found elsewhere in the same block, or in a block that is the
  positional successor of the last known ref. Offset updated. This is the case that
  currently requires `refAliases` plus positional aliasing.
- **ambiguous** — the quote appears more than once and `prefix`/`suffix` cannot
  disambiguate. Resolve to the positionally closest candidate and mark for review.
- **lost** — the quote is gone. The annotation is surfaced as lost, never silently dropped.

Ordering matters and is the heart of the change: try `exact`, then same-block search, then
successor-block search, then give up. Every step is a *search for text that was recorded*,
not a *guess at an identity that was thrown away*.

### Schema migration

`Sidecar.schemaVersion` goes `1` to `2`.

- v1 comments already carry `textAnchor`; migration lifts `selectedText` / `start` /
  `end` / `baseMarkdown` into the anchor unchanged. Nothing is invented.
- v1 suggestions carry only `ref` and `range`, so their `quote` is recovered at migration
  time by slicing the block's markdown at `range.start..range.end`. For a suggestion whose
  block is already gone, no quote can be honestly reconstructed.
- An annotation whose ref is already dead at migration time gets `anchor: null` and
  `stale: true` — it cannot be honestly recovered, and saying so is better than inventing
  a position. There are ~12 such suggestions in the live test workspace today.
- Existing `ref` fields are retained on v2 records as a read-only fallback for one
  release, then removed. `refAliases` and `resolveRef` are deleted from the op applier.

Migration runs on sidecar read, is idempotent, and is covered by a fixture of a real v1
sidecar.

### Single-writer revision

The base-revision races (`de295be`, `4b6aa2a`) are symptoms of the client assembling a
revision from three racing sources. In v2 the sidecar's `revision` is the only authority
and **every** mutation path — op applier, editor save, watcher refresh — goes through one
mutator that increments it and returns it. Clients adopt what they are handed and never
compute a base. This removes the class rather than adding a third monotonic guard.

### Where it plugs in

- `src/lib/proof/block-refs.ts` — keeps `assignRefs`, `textHash`, drops `computeRefDelta`.
- New anchor module — record shape, resolution, and the migration.
- `src/lib/proof/ops-applier.ts` — annotation ops resolve anchors; `refAliases` and the
  positional pass are deleted.
- `src/components/editor/extensions/comment-highlight.ts` — decorate by resolved anchor
  range. The block-scoped fallback added in `e7292e3` stays as the `ambiguous`/`lost` path.
- Editor and comment-pip read `anchorId`; `data-block-ref` stays for DOM lookup.

## Testing decisions

Test the resolution algorithm directly and the sidecar round trip, not the UI. The
algorithm is pure and is where every bug in this area has lived.

Highest existing seam: `src/tests/proof/` runs pure proof-module tests via `tsx`, already
covering refs, anchors, sidecars and the op applier. No new seam is needed.

Cases that must be pinned, each of which is a bug that shipped:

1. Type inside a commented sentence → anchor status `moved`, highlight follows the text.
2. Edit a block in place → annotation survives (`6f9fd72`'s case).
3. Insert a block above → offsets shift, annotation unchanged.
4. Delete the annotated paragraph → `lost`, comment marked, no cancellation of an
   identical sibling paragraph (`survivesViaAlias`'s case).
5. Duplicate text, disambiguate by prefix/suffix → `ambiguous` resolves positionally.
6. v1 sidecar with a dead ref → migrates to `stale`, is not silently dropped.
7. Migration is idempotent — running it twice changes nothing.
8. A keystroke burst produces one suggestion and zero `409`s (`de295be`'s case).

Prior art to follow: `comment-highlight.test.ts` (decoration ranges), and the
perturb-and-restore ledger in `.review/perturb-f1f4.sh`, which verifies a guard is
load-bearing by disabling it and confirming a test fails. Every new guard joins that
ledger.

## Out of scope

- Real-time multi-cursor collaboration. Still single-writer.
- Changing the `.md` file format. The file stays the source of truth; anchors live only
  in the sidecar.
- Rich-text or inline formatting anchors. Block plus character offset only.
- Undo/redo across annotation state.
- Google Docs' suggestion UX (accept/reject per change within a run). This change
  addresses durability only.

## Further notes

**Why keep block refs at all.** Because the `.md` is authoritative and can be edited by
`vim`. After an external edit the app must re-derive structure from text; a content hash
is a reasonable way to match blocks across that boundary. The mistake was letting that
hash also be the *identity of annotations*. Refs stay as the bridge; anchors become the
identity.

**Why this is smaller than it first looked.** `comment-highlight.ts` already resolves a
comment to a range by finding `selectedText` within a scoped block span (the fix in
`e7292e3`). That search is the recovery algorithm — it is simply scoped to the *current*
block and only ever runs for highlighting, after identity has already been resolved by
`ref`. Promoting it to the identity path is closer to a reordering than a rewrite.

**Honest limitation.** Anchors still ultimately point into text. If a user deletes the
sentence a comment is on, the comment is lost — Google Docs behaves the same way. The
difference is that this design loses it *at the moment the text is deleted*, and can say
so, instead of losing it on any edit at all.

**What this does not fix.** The base-0 report is not yet explained. If it is a load-path
bug — the store never seeded for the path — single-writer revision will not fix it, and I
should not claim it does. It needs a separate diagnosis with the log line before the first
`base 0`.

## Acceptance criteria

Runnable, in order:

1. `pnpm typecheck` — zero new errors over the one pre-existing `TS7022`.
2. `node_modules/.bin/tsx scripts/test-floor.mjs` — all pass, floor not lowered.
3. The eight resolution cases above exist as tests and pass.
4. Every new guard is added to `.review/perturb-f1f4.sh` and the ledger shows
   `restored-to-HEAD=YES` with a non-zero failing count when the guard is disabled.
5. A v1 sidecar fixture migrates to v2 on read, twice, with a stable result.
6. Live: type inside a commented sentence in Suggesting mode; screenshot shows the
   comment still highlighting the sentence. Delete that paragraph; screenshot shows the
   comment marked lost and an identical sibling's comment untouched.
7. `docs/ux-contracts.md` updated in the same change.