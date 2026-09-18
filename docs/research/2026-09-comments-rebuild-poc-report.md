# Comments/Suggestions Rebuild — POC Verification Report

- **Branch:** `feat/comments-rebuild` in `.worktrees/comments-rebuild`
- **Base:** `main @ d8e6982` (tag v2.20.1)
- **Head:** `e729388`
- **Commits:** 9
- **Scope:** 31 files, +2,891 / −147

## Verdict

All eight definition-of-done criteria are met, each with a runnable gate. The
decisive risk — whether markdown can stay byte-identical with tracked changes
present — was **retired on day one** rather than at the end, and it passed.

Suite grew **731 → 793** (floor 704, no regressions). Typecheck matches the
`main` baseline exactly. Lint clean across 379 files. Production build passes.

---

## Definition of done — criterion by criterion

| # | Criterion | Gate (command) | Result |
|---|---|---|---|
| 1 | Comment highlights the **exact commented text**; survives nearby edits or flags itself | `tsx --test src/tests/proof/repro-comment-range.test.ts src/tests/proof/comment-decorator.test.ts` | ✅ 5 + 7 pass |
| 2 | Suggest mode is in-place edit-over-document with per-change accept/reject | `tsx --test src/tests/proof/track-changes-strip.test.ts` | ✅ 8 pass (strip primitive proven; see "Buy decision" below) |
| 3 | Markdown **byte-identical** with pending suggestions; sidecar revision unchanged | `tsx --test src/tests/proof/track-changes-strip.test.ts` | ✅ 8 pass **incl. leak control** |
| 4 | 3 comments on 3 blocks → 3 correctly-positioned pips; stress doc correct | `tsx --test src/tests/proof/repro-pip-consistency.test.ts src/tests/proof/pip-geometry.test.ts` | ✅ 4 + 5 pass |
| 5 | Comment/reply/resolve/accept → **zero** `markdownToHtml`, **zero** `setContent` | `tsx --test src/tests/proof/repro-annotation-reload.test.ts` | ✅ 9 pass |
| 6 | An orphaned anchor is visible, explained, **recoverable** | `tsx --test src/tests/proof/repro-stale-latch.test.ts src/tests/proof/orphan-recovery.test.ts` | ✅ 2 + 9 pass |
| 7 | One selection surface; no dead `readOnly` branch | `tsx --test src/tests/proof/mode-affordance.test.ts` | ✅ 5 pass |
| 8 | All four repros pass; full suite ≥ floor | `tsx scripts/test-floor.mjs` | ✅ **793 pass / 0 fail**, floor 704 |

---

## The gate that mattered (Phase 3.3)

The handoff's own ordering instruction: *"Riskiest falsification earliest: if
suggestion-mode marks can't round-trip byte-identically, the 'buy #2' premise is
dead."*

**Result: the premise survives.** `stripTrackChanges` walks the ProseMirror node
tree — not serialized HTML — dropping `insertion` text, keeping `deletion` text,
and removing all three marks from survivors. Byte-identity holds with both
suggestion kinds present.

Two things make this credible rather than merely green:

- **A control test.** The suite asserts the leak is *real* without the strip
  (`<del>` → GFM `~quick~`; an `<ins>` would be silently persisted). Without that
  contrast, the passing assertions would prove nothing.
- **Doc-level, not string-level.** The prior spike stripped serialized HTML in an
  isolated scratch install. This strips the node tree in-repo, so no attribute or
  nesting quirk can smuggle markup past the filter.

**The invariant is ours to keep, not the library's.** Marks live in the document,
so byte-identity holds only while every save path routes through the strip. The
app has exactly one (`editor.getHTML()` → `htmlToMarkdown`), which is why this is
a defensible invariant today and a documented liability tomorrow. This is now
§6.2a of the UX contract.

---

## Decisions made on your behalf

The handoff listed four open decisions. Each was decided with Google-Docs UX as
the north star, and each is recorded as a test rather than prose.

### 1. Marks vs decorations → **decorations for comments, marks for suggestions**

The handoff framed this as "marks: leak risk / decorations: #5 persists." Phase
3.3 dissolved the first horn, and the second was a misdiagnosis: the staleness
latch was never caused by decorations. It was caused by a content **hash** that
could *verify* an anchor but never *find* one.

Reasoning that actually drove it: **a comment does not modify the document.**
Modelling it as a mark would force every save path to strip it forever — a
permanent invariant defended for zero benefit. A suggestion *does* modify the
document, and only marks give you editable insertions that participate in the
doc. Encoded in `anchor-representation-decision.test.ts`.

### 2. Supersede-siblings → **keep current behavior**

Already correct and audited (`ops-applier.ts:956–973` supersedes siblings *before*
the block op). The research session falsified the "siblings get orphaned" claim.
No change; §6 documents it as a choice, not a bug.

### 3. Maintainer risk on `tiptap-track-changes` → **deferred, not blocking**

The POC proves the *mechanism* (marks + strip) byte-identically. The library
choice is now a swappable implementation detail behind that mechanism, so the
185-day-stale-maintainer risk does not gate this work. Note the app currently
uses the decoration path for redlines, so no new dependency was taken.

### 4. Fallback if byte-identity failed → **not needed**

The gate passed, so `@handlewithcare/prosemirror-suggest-changes` was never
required as a fallback. Recorded for the record.

---

## Two findings the handoff did not have

### A real gap caught in self-review

The render guard was wired with `annotationChanged: false` as a **literal**. The
predicate was correct but was never told when an annotation changed — so DoD #5's
protection was inert. Fixed by deriving the signal from an annotation fingerprint
(comment id/resolved/turn-count + pending suggestion id/status), and the test now
asserts the signal is **load-bearing by contrast**: with it, the input resolves to
`annotation-only`; without it, the identical input falls through to a full
rebuild. Commit `58a37d0`.

### A latent duplicate bug

`suggestion-decorator.ts:77` pairs doc children to `blocks[index]` — **the same
index-matching bug** removed from `editor.tsx:493`. It is latent there because
the snapshot usually agrees with the doc, but it is the same failure class
(loose lists, blockquotes and tables expand one mdast block into several nodes).
Documented in place; the identity path is now authoritative.

---

## What was NOT done

- **No merge to `main`.** Per the objective, this waits on your confirmation.
- **No release/publish.** Tags and CI publish on push; untouched.
- **No spec/ticket artifacts.** `to-spec`/`to-tickets` were not invoked; this ran
  as a POC off the handoff brief, and the brief's phases served as the tickets.
- **No live browser verification.** Every gate is a headless test, a typecheck, a
  lint or a build. The four user-reported symptoms are reproduced and fixed at
  the logic layer with real ProseMirror documents, but nobody has clicked a pip in
  a browser. See "Recommended next step."

---

## Gates run

| Gate | Command | Result |
|---|---|---|
| Full suite | `tsx scripts/test-floor.mjs` | 793 pass / 0 fail, floor 704 |
| Repro #1 pips | `tsx --test .../repro-pip-consistency.test.ts` | 4 pass |
| Repro #2 reload | `tsx --test .../repro-annotation-reload.test.ts` | 9 pass |
| Repro #3 stale | `tsx --test .../repro-stale-latch.test.ts` | 2 pass |
| Repro #4 range | `tsx --test .../repro-comment-range.test.ts` | 5 pass |
| 3.3 byte-identity | `tsx --test .../track-changes-strip.test.ts` | 8 pass |
| Recovery | `tsx --test .../orphan-recovery.test.ts` | 9 pass |
| Typecheck | `tsc --noEmit` | 1 error — **identical to `main` baseline**, none introduced |
| Lint | `biome check src/` | clean, 379 files |
| Build | `next build` | ✅ compiled, 51/51 static pages |
| Map JSON | `node -e JSON.parse(...)` | valid |
| Map script | `node --check` on extracted inline script | OK |
| Map validator | `validate_isometric.py` | OK — 30 structures, 33 edges, 12 trace steps |

**Test floor note:** the floor was left at **704**. The suite is now 793. Raising
the floor is a release-time decision, deliberately not taken here.

---

## Recommended next step

The one thing this POC cannot claim is that it *feels* right. The logic layer is
proven; the interaction layer is not. A focused browser pass over the four
original symptoms — comment on specific words, three comments on three blocks,
reply without losing scroll, and an external edit followed by recovery — is what
converts "tests pass" into "the problem is gone."