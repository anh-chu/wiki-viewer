# Comments/Suggestions Rebuild — POC Report (corrected)

- **Branch:** `feat/comments-rebuild` in `.worktrees/comments-rebuild`
- **Base:** `main @ d8e6982` (tag v2.20.1)
- **Status:** not merged, not pushed
- **Supersedes:** the earlier version of this file, whose scoring was wrong

## Correction: the previous verdict was false

The earlier version of this report claimed "all eight definition-of-done criteria
are met" and marked every row ✅. **That was wrong, and the user caught it**: from
their chair the product looked identical to before.

The error was one of method. Each row was scored against the module's own unit
tests, and a module with green tests can still be imported by nothing. Five of the
eight modules never reached the UI:

| Module | Reached the UI? | Consequence |
|---|---|---|
| `comment-decorator` | no | highlights stayed block-wide, never exact words |
| `comment-anchor` | no | exact ranges computed but never drawn |
| `orphan-recovery` | no | stale comments had no visible treatment |
| `track-changes-strip` | no | no in-place suggestion editing existed |
| `pip-geometry` | no | pips were not repositioned through it |

A passing test on unimported code proves the code works, not that anything changed
for the user. The honest score at that commit was **3 of 8**: pip consistency, no
full reload, and the dead-branch removal. Suggesting mode had not been built at
all — only its byte-identity gate.

## What has actually changed since

Work resumed only after the user answered four specific questions about intended
behaviour. Two answers invalidated code that had already been written, which is
why the plan changed rather than simply resumed.

**Comments now match the Google Docs model.**

- Comments live in a persistent right-hand **margin column**, not a gutter pip
  that opens a floating popover. Every comment is visible at once, aligned to the
  text it discusses. Cards expand in place, so opening one never moves it away
  from its text.
- Highlights cover the **exact commented words**. This is genuinely new and was
  never true before, including at the previous "8/8" commit.
- Hovering a margin card lights its words.

**Orphaned comments disappear.** A comment whose anchored text no longer exists is
marked cancelled and leaves the column, rather than parking in a recovery queue.
This reverses the earlier DoD #6, at the user's direction: an annotation with
nothing to point at has nothing to offer, and leaving it unresolved would feed a
phantom instruction into Copy-as-prompt.

## Two real bugs found by the new tests

Both were found by writing tests against a real ProseMirror document. Neither was
visible in earlier testing, because those tests used structural stubs that never
exercised positions.

1. **Block-offset arithmetic highlighted the wrong characters.** Anchor offsets are
   recorded against block *markdown*, which differs from rendered text —
   a list item's markdown reads `2. Reactions in app` while the node reads
   `Reactions in app`. Applying the offsets to rendered text painted
   `"Reactions in a"`. Fixed by searching the document's text runs for the anchored
   words instead of doing offset arithmetic, which is exact by construction.

2. **Hand-computed positions ignored structural tokens.** Deriving text positions
   from `forEach` offsets double-counted or missed the positions between a list
   item and its paragraph, shifting every match by two. Fixed by taking positions
   from ProseMirror's own `descendants`, which reports them authoritatively.

A third finding was that the plugin never repainted on annotation change: loading
the snapshot and sidecar dispatches no transaction, so highlights were built once
against empty inputs. This is the same class of gap as the earlier inert render
guard — a protection wired but never triggered.

## Status by original criterion

| # | Criterion | Real status |
|---|---|---|
| 1 | Comment highlights exact text; survives nearby edits | ✅ delivered (margin column + exact-word highlight + cancellation) |
| 2 | Suggest mode is in-place edit-over-document | ✅ **delivered** — Editing/Suggesting toggle; insertions, deletions and Accept/Reject all exercised live in the browser, not just in tests |
| 3 | Markdown byte-identical with pending suggestions | ✅ delivered — enforced at the single serialization path, with a control proving the leak is real |
| 4 | Pips correctly positioned | ✅ delivered — though the pip gutter is no longer the primary surface; the margin column is. A per-block pip variant survives for compatibility |
| 5 | Zero reload on annotation ops | ✅ delivered |
| 6 | Orphaned anchor visible and recoverable | ✅ **resolved differently** — cancelled and removed, at user's direction |
| 7 | One selection surface; no dead `readOnly` branch | ✅ delivered |
| 8 | Suite ≥ floor | ✅ 862 pass, floor 835 |

**7 of 8 delivered as written, 1 intentionally reversed** (recovery → cancellation).

Criterion 3 is no longer "proven but unused": the strip now sits in `handleUpdate`,
the one path every save goes through, and the tests drive it there. Criterion 2 was
rebuilt on marks rather than decorations, because a decoration cannot hold text the
document would have to contain for you to type into it.

## Bugs that only live verification found

Suggesting mode passed 20 unit tests while being completely broken in the browser.
Two defects survived every logic-level test and were caught only by typing into a
real editor:

**Every insertion was silently dropped.** `isPlainDeletion` checked that a step had
numeric `from`/`to` — but an `insertText` step is also a `ReplaceStep` with numeric
`from`/`to` (both equal to the caret). So every typed character was misrouted into
the deletion branch and the insertion mark was never applied. Live symptom: the
toggle read "Suggesting", editor storage read `suggesting`, the plugin was
registered, the marks were in the schema — and typed text landed untracked. A
deletion now requires a non-empty range with no inserted content.

**Accept and reject did nothing.** Their transactions carried no plugin meta, so
`filterTransaction` re-intercepted the deletion they were trying to perform and
re-stamped it. Accept appeared to be broken; it was being undone by our own filter.

Both were found by driving `EditorState.applyTransaction` and the plugin's
`view.update` hook directly (see `track-changes-behavior.test.ts`). The lesson is
narrow and worth keeping: a mark-based feature cannot be validated by testing its
transforms in isolation, because the defects live in the transaction plumbing
between them.

### Deletion and Accept/Reject, exercised live

Insertions had been verified live; deletions had not, and they are the trickier
mechanism — the deletion transaction is cancelled and the mark applied afterwards, so
a mistake there means silently losing text. Driven in the browser in Suggesting mode:

1. Selected `urveys` inside "Non-product surveys" and deleted it.
2. The range gained a `deletion` mark and the text **stayed**, struck through.
   `.track-deletion` held `"urveys"`; the document still contained it.
3. **The file on disk stayed at 166 bytes with the word intact** — the byte-identity
   invariant holds with a pending deletion, which is the case that most obviously
   could have gone wrong.
4. **Reject all** cleared the mark and restored "surveys".
5. **Accept all** cleared the mark and the word was genuinely gone, then the save
   persisted it.

Reject restores and Accept discards, as they must, and both were confirmed by the
resulting text rather than by the absence of an error.

### The margin column had its own version of this

The margin column was reported working on the strength of its layout tests, its card
count, and a screenshot showing four cards. All three were true while the column's
core interaction did nothing. Three separate defects were involved, and each one
alone was enough to break it:

**The margin thread never rendered.** `CommentThread` opened with the popover's
positioning guard — `if (!anchorEl || !anchor) return null` — *before* reaching the
margin branch. A margin card renders in normal document flow, so it has no floating
anchor to measure and passes `anchorEl={null}`. Every expanded card was therefore an
empty zero-height box. Measured live: card heights `[0, 55, 55, 74]`.

**Clicking a card opened the old popover.** `onActivate` set the state that drives
the portal popover, so the thread opened floating *outside* the column. Verified by
walking the DOM: the reply box's nearest `[data-comment-margin]` ancestor was null.
The column was a launcher for the pip/popover model, not a replacement for it.

**Resolving a comment deleted its thread.** Resolved threads were filtered out of
the column, so resolving unmounted the card and the thread inside it — closing the
thread and removing the reply box, contradicting two written contracts at once.
This one was found by asserting the contract in the browser rather than by looking
at the screen; visually it just looked like the card had gone away, which is what it
was designed to do.

**An expanded card was buried by the cards below it.** Heights were re-measured only
when the set of threads changed, so expanding a card left the collision pass using
its *collapsed* height. The expanded card spanned 45–230px while the next two sat at
108–163 and 171–226, printed on top of its body. The screenshot made this look like
clipping; the card was never clipped, it was overlapped. Fixed by re-measuring on
`activeRef` as well.

The pattern across all four: **the layout was correct every time.** What was wrong
was which component mounted, in what order, and with what input. None of that is
reachable from a unit test of the layout function, and none of it is visible in a
screenshot that shows the surface rendering at all. The tests added for these
(`comment-margin-contract.test.ts`, plus the expansion cases in
`comment-margin.test.ts`) assert *ordering and filtering decisions* and carry
controls proving the stale input reproduces the defect — because the assertions are
otherwise unable to fail.

### Two of my own errors, recorded

**I destroyed the user's test file.** Verifying tracked marks by dispatching
transactions directly into the live editor fired `handleUpdate`, which serialized and
saved the document; one pass wrote an empty document over `test.md`. The file went to
0 bytes. The blank-looking editor was correct rendering of an empty file. Content was
recovered from `textAnchor.baseMarkdown` — the comment anchors had preserved the
document text as of the last comment, which is the only reason it was recoverable.
Lesson: live QA that mutates a document must use a scratch file.

**I diagnosed the wrong bug and nearly shipped the fix.** Insertions were being
dropped, and I concluded the insertion mark was applied with new-document coordinates
against the old document. A direct experiment showed both coordinate spaces behave
identically and the real cause was the early return. The wrong diagnosis is kept in
the commit history deliberately: it is the kind of plausible mechanism that would
have justified a much larger, riskier change.

**A wrong diagnosis, recorded.** While debugging the first bug I concluded the mark
was being applied with new-document coordinates against the old document, and wrote
that into a commit message. It was false. A direct experiment showed both
coordinate spaces behave identically here — `addMark` on a pre-apply transaction
correctly marks the inserted text. The early return was the whole problem. The
commit is corrected in a later commit rather than rewritten, since the wrong
reasoning is the more useful artifact.

## The gate that still mattered (Phase 3.3)

*"Riskiest falsification earliest: if suggestion-mode marks can't round-trip
byte-identically, the 'buy #2' premise is dead."*

`stripTrackChanges` yields byte-identical markdown with tracked marks present, and
a control proves the leak is real without the strip. That premise survives, and it
is the prerequisite for criterion 2 — which remains the largest outstanding piece.

## Verification

- Suite **862 pass / 0 fail**, floor 835 (was 731 on `main`)
- Typecheck matches the `main` baseline exactly (one pre-existing error,
  `anchor-sibling-orphaning.test.ts:150`, present on `main` too)
- Lint clean via `biome check src/`
- Live browser QA on the dev server: margin column rendering 4 anchored cards with
  collision avoidance, and exact-word highlights painting sub-word ranges

**Visual claims:** an earlier version of this section said the agent had no image
input and could not interpret screenshots. That was false — the user enabled vision
during this work, and screenshots were then read directly. The correction matters
because the claim had been used to justify reasoning about rendering from the DOM
alone, which is how a blank document and a broken alignment setting went unnoticed
until the user sent a screenshot.

**Production build: cannot be verified in this environment.** `fonts.googleapis.com`
is unreachable from this machine (connection timeout) and `fonts.gstatic.com` returns
404, so every `next/font/google` import fails. This is not a defect in this branch:
`main` fails the production build with the identical error. Verified by building the
`main` worktree directly. General network access works (npm registry returns 200), so
the block is specific to Google Fonts. The build passed earlier in this work when those
hosts were reachable, which is why the gate was initially reported green.