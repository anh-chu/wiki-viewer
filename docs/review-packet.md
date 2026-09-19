# Review packet — comments/suggestions rebuild (POC)

Self-contained context for independent reviewers. Everything here was verified in this
session; anything I could not verify is labelled as such rather than rounded up.

## What to review

| | |
|---|---|
| Worktree | `/home/sil/wiki-viewer/.worktrees/comments-rebuild` |
| Branch | `feat/comments-rebuild` (no upstream — never pushed) |
| HEAD | `ffba2bc` — the commit under review. |
| Base | `main` @ `d8e6982` (tag v2.20.1) |
| Size | 60 commits, 61 files |
| State | tree clean, nothing merged, nothing published |

Nothing is merged or published, and that requires the user's explicit confirmation.

## The task

Rebuild the comments/suggestions UX to match Google Docs, per an approved change list:

- **A.** Comments move from a gutter pip + popover to a right-hand **margin column** of
  cards tracked to their anchors.
- **B.** Comment highlights land on **exact words** via the `comment-decorator`
  ProseMirror plugin, which was written but never imported.
- **C.** **Suggesting mode** on ProseMirror marks (insertion/deletion/modification) with
  an Editing/Suggesting toolbar toggle; typing stamps insertions; the track-changes strip
  is wired into the single serialization path so `.md` stays byte-identical while
  suggestions are pending; the decoration-based redline is retired.
- **D.** Orphaned comments **disappear as cancelled** — delete `orphan-recovery.ts`, no
  recovery UI.
- **E.** Correct the POC report (its "8/8 done" claim was false, really 3/8) and rewrite
  `docs/ux-contracts.md` for the new behaviour.

Constraints: annotation surfaces identical in view and edit mode; user-facing vocabulary
exactly "comment"/"suggestion"; resolved threads always show the reply box; successful
ops keep the thread open.

## Where the change lives

New source files:

| File | Lines | Role |
|---|---|---|
| `src/components/editor/comment-margin.tsx` | 207 | the margin column; absolutely positioned so it does not shift document centring |
| `src/components/editor/extensions/comment-highlight.ts` | 268 | highlight plugin, built on the decorator |
| `src/components/editor/extensions/track-changes-behavior.ts` | 397 | marks behaviour: stamping, accept/reject |
| `src/components/editor/extensions/track-changes.ts` | 186 | mode state handed to the plugin |
| `src/lib/proof/comment-anchor.ts` | 95 | text-range anchoring |
| `src/lib/proof/comment-decorator.ts` | 190 | descriptors → ProseMirror decorations |
| `src/lib/proof/track-changes-strip.ts` | 151 | strips tracked changes for serialization |

Heavily modified: `src/components/editor/editor.tsx` (1758), `comment-thread.tsx` (430),
`src/components/wiki/viewer-pane.tsx` (831), `src/lib/proof/ops-applier.ts`,
`src/app/api/wiki/content/route.ts`, `docs/ux-contracts.md` (+455/−73).

Test growth: **731 → 944**. Both measured with the same runner in this session; the
floor moved 704 → 835.

## Evidence, by gate

All re-run at `ffba2bc`, the commit under review:

| Gate | Result |
|---|---|
| Suite | **944 pass / 0 fail**, floor 835 |
| Typecheck | **1 error**, the pre-existing `main` baseline (`anchor-sibling-orphaning.test.ts(150,9) TS7022`) |
| Lint | clean, 390 files, 3 warnings |
| Production build | **passes** — `Compiled successfully in 41s`, 51/51 pages, standalone `server.js` emitted and booted |
| Live browser QA | performed on `devvm:3002` via browser-relay |

Live confirmations (each was a real browser run, not inference):

- **B** — the two anchored comments render as inline marks on "Reactions in app" and
  "Collect " — phrases, not blocks — with a background tint and `cursor: pointer`.
- **C** — toggling changed the control from "Editing: your edits apply directly" to
  "Suggesting: your edits are tracked until accepted"; typing produced a real `<ins>`
  with the insertion mark and surfaced the Accept-all control; the file stayed at
  **166 bytes / revision unchanged** while pending; Accept took it to 236 bytes.
- **D** — the margin dropped from **4 cards to 3** on save, with the orphan gaining
  `cancelReason: "anchor-lost"`; resolved threads stayed.
- Constraints — view mode offers both **Comment** and **Suggest** on selection; rendered
  text contains no annotation/redline/orphan/stale/pip; a resolved card expands with its
  composer present; replying leaves the thread open.

Previous rounds also verified live: deleting a commented word kept the text and held the
file at 166 bytes; Reject restored it; Accept removed it.

## Defects found during this work (and how)

These came from looking at the running app, not from the suite. A reviewer may reasonably
ask whether each fix is correct and complete.

1. **The editor was unmounted on every reload.** `{fileLoading ? <Spinner/> : <KBEditor/>}`
   — `fileLoading` goes true on *every* external change, so the spinner replaced the
   editor and destroyed all component state. Three symptoms (a collapsing card, Suggesting
   reverting to Editing, Source mode discarding its draft) were fixed one at a time before
   the shared cause was found and fixed.
2. **A direct save never reconciled refs.** `PUT /api/wiki/content` bumped the sidecar
   revision and fingerprint but never recomputed `refMap`, so comments whose text was
   deleted were never cancelled — cards pointing at nothing. Fixed by exporting
   `reconcileRefsAndCancelOrphans` and calling it after the write.
3. **Suggesting mode leaked across documents** (my own bug — I made it a singleton).
   Now keyed by path.
4. **The pencil that enters edit mode was unnamed** — icon-only, no `title`/`aria-label`,
   and the only way into edit mode for a text file.

## Method notes a reviewer should weigh

- **"Claim ahead of evidence" was the recurring failure.** Commit `1005ce3` claimed a
  revert its diff did not carry; the POC report originally claimed 8/8 with unimported
  modules. Every claim is now backed by a check, and **each new guard was verified to
  fail on the code it protects** before being kept.
- **Wrong diagnoses are recorded, not hidden**: a claimed insertion-coordinate bug
  disproved by experiment; empty-column/delayed-clear guesses disproved by 100ms DOM
  sampling; a predicted stale-suggestion vulnerability disproved by a direct test.
- **Two self-corrections in tests**: I passed a file *path* where a suite constant held
  source text (3 cases failed), and used the `s` regex flag unavailable at the project's
  target.

## Known gaps — please scrutinise these

1. **The user's file was damaged twice** by my live QA (`/home/sil/seedwise/test.md`:
   truncated to 0 bytes once, reformatted 166→231 once). Both recovered; it is 166 bytes
   now. Recorded in the report on purpose.
2. **A real save reformats untouched parts** of a document (`1. ` → `1.  `, trailing
   whitespace added). **Pre-existing on `main`** — I verified `main` behaves identically.
   Byte-identity only holds while suggestions are *pending*.
3. **`.qa-addws.ts` was committed by a broad `git add -A`** and removed at the tip in
   `b3cc5f9`. It still exists in `f81fe41`'s history.
4. **Edit mode is reachable only through that one pencil icon** — no keyboard shortcut.
   Named now, but still the sole entry point.
5. **`isometric-codebase-map.json` shows +1308/−162.** I updated it, but it is a large
   generated artifact and worth a spot check for hand-edit noise.
6. Live QA ran against a **dev server**; the production build was verified as compiling
   and booting, not driven through a browser.

## Artifacts for review

Split patches, generated from `main..HEAD`, so a reviewer can read a slice
without the whole 8900-line diff:

| File | Lines | Covers |
|---|---|---|
| `.review/diff-proof-lib.patch` | 1440 | `src/lib/proof` — anchoring, decorator, ops-applier, strip |
| `.review/diff-components.patch` | 2286 | `src/components` — margin, thread, editor, viewer-pane |
| `.review/diff-app-docs.patch` | 938 | `src/app` routes and `docs/` |
| `.review/diff-tests.patch` | 4240 | every added/changed test |

These are generated scratch output, not part of the deliverable; `.review/` is ignored.

## Suggested review angles

- **Correctness of the Markdown round-trip**: does anything besides a pending suggestion
  change the stored bytes? Is the `1. ` → `1.  ` reformatting the only divergence?
- **Concurrency**: two writers touching a sidecar, or an agent writing while the editor is
  open. Does the ref reconciliation race with anything?
- **The margin's absolute positioning**: it was made an overlay to stop it stealing
  horizontal space from a centred column. Does that hold at other widths, with the sidebar
  open, and narrow viewports?
- **State persistence**: four module-scope maps/singletons now outlive the component
  (`expandedMarginByPath`, `suggestingModeByPath`, `sourceDraftByPath`, `sourceModeByPath`).
  Two are path-keyed maps that could grow; is the lifecycle right, and is any entry ever
  stale?
- **Whether each guard actually tests behaviour** or merely asserts that source text
  contains a string. Several do the latter — a deliberate tradeoff, but worth judging.

## Review history

This worktree has now been reviewed by five independent reviewers. Findings and their
disposition, so a reader can judge what was already examined:

| # | Finding | Disposition |
|---|---|---|
| 1 | `PUT /wiki/content` never recomputed `refMap`; orphaned comments were never cancelled | fixed, live-verified (4 → 3 cards) |
| 2 | A surviving duplicate cancelled its sibling's comment (refs are content-derived) | fixed; guard fails 3/6 on old code |
| 3 | The route guard matched commented-out code (vacuous) | fixed; fails 4/2 when disabled |
| 4 | `ux-contracts.md` contradicted code and itself on resolved cards | doc corrected |
| 5 | Criterion 4 scored "delivered" on `pip-geometry`, imported only by its test | row corrected to "partial" |
| 6 | Weak CONTROL asserting only that `.filter(` exists | strengthened; fails 4/2 on removal |
| 7 | 115 test fixtures committed (55 added by this branch) | untracked and ignored |
| 8 | **Typed suggestions were never recorded** — marks stripped on save, text applied as a permanent edit | fixed, live-verified (record `sa551`, file held at 166 bytes) |
| 9 | Source-mode exit never re-seeded the no-op baseline | fixed, live-verified byte-identical |
| 10 | Modification strip deleted pre-existing formatting | partially fixed (outside the wrapper); inside is a documented tradeoff |

Two findings were **rejected after investigation**, and the reasons are worth knowing:

- A predicted "stale suggestion can be accepted and writes phantom markdown" was
  disproved by experiment: accept re-emits a block op that fails the ordinary guard with
  `409 BLOCK_NOT_FOUND`, leaving the file untouched.
- "Make the doc-level strip the shipped path" was implemented and the byte-identity gate
  rejected it: keeping formatting inside a modification wrapper lets `**bold**` reach the
  canonical file. The claim was narrowed instead.

A review finding is a hypothesis. Two of the ten above did not survive being checked, and
one of my own fixes passed its own guard while the feature was still broken.
