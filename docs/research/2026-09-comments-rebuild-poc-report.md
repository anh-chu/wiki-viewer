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
| 1 | Comment highlights exact text; survives nearby edits | ✅ now delivered (margin + exact highlight + cancellation) |
| 2 | Suggest mode is in-place edit-over-document | ❌ **not built** — still a committed-suggestion popover |
| 3 | Markdown byte-identical with pending suggestions | ⚠️ primitive proven; no UI path exercises it yet |
| 4 | Pips correctly positioned | ✅ delivered |
| 5 | Zero reload on annotation ops | ✅ delivered |
| 6 | Orphaned anchor visible and recoverable | ✅ **resolved differently** — cancelled and removed, at user's direction |
| 7 | One selection surface; no dead `readOnly` branch | ✅ delivered |
| 8 | Suite ≥ floor | ✅ 812 pass, floor 704 |

**5 of 8 delivered, 1 not built, 1 partially, 1 intentionally reversed.**

## The gate that still mattered (Phase 3.3)

*"Riskiest falsification earliest: if suggestion-mode marks can't round-trip
byte-identically, the 'buy #2' premise is dead."*

`stripTrackChanges` yields byte-identical markdown with tracked marks present, and
a control proves the leak is real without the strip. That premise survives, and it
is the prerequisite for criterion 2 — which remains the largest outstanding piece.

## Verification

- Suite **812 pass / 0 fail**, floor 704 (was 731 on `main`)
- Typecheck matches the `main` baseline exactly (one pre-existing error,
  `anchor-sibling-orphaning.test.ts:150`, present on `main` too)
- Lint clean via `biome check src/`
- Live browser QA on the dev server: margin column rendering 4 anchored cards with
  collision avoidance, and exact-word highlights painting sub-word ranges

**Caveat on visual claims:** the agent performing this work has no image input, so
screenshots could not be interpreted. All live findings came from DOM reads, the
accessibility tree, and API responses. Rendering has been verified structurally,
not visually.