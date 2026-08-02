# Implementation Plan: Zero-Friction Agent Review Loop

Grounded in `/home/sil/wiki-viewer/docs/review-loop-recon.md` plus direct verification of `src/app/api/wiki/watch/route.ts`, `src/lib/search/watcher-pool.ts:54`, `src/lib/proof/ops-applier.ts:486`, and `AGENTS.md`. Facts not found in either source are flagged as open questions.

## 1. Summary + Smallest Viable Cut

The loop: agent edits files directly on disk (unchanged); when the user requests a review, a prompt is injected into the live agent tmux session; the agent appends quote-anchored entries to `.proof/<path>.review.md`; wiki-viewer watches `.proof/**/*.review.md`, parses leniently, resolves quotes to block refs, and folds entries into the existing canonical sidecar (`.proof/<path>.json`) so the existing comment-pip and suggestion-card UI renders them with zero new UI surfaces. Human replies/comments flow back as injected quote-anchored text.

**Smallest viable cut (proves the loop end to end):** Phase A alone, exercised manually. Implement grammar + parser + quote resolver + reconcile-into-sidecar + `.proof/` watcher; the "injection" step is a human pasting the prompt into the agent session by hand. This ships value immediately (any agent instructed by any means can drop a `.review.md` and it appears as native comments/suggestions in the UI) and de-risks the guppi dependency, which recon found does not exist yet (recon section 7: no external injection endpoint, no `SendKeys()` in `pkg/tmux/client.go`).

Phase order: A (agent -> human, file-based, no guppi needed) -> B (one-click review trigger via guppi injection) -> C (human -> agent injection of UI comments).

## 2. Phases

### Phase A: `.review.md` ingestion (wiki-viewer only, independently shippable)

1. Define the review grammar (see section 4) and document it in `agents/` bootstrap material so any agent can produce it.
2. `review-parser.ts`: lenient line-oriented parser. Malformed entry -> skip, record a warning entry (never reject the file). Append-friendly: entries are self-delimited; parser is idempotent over the whole file.
3. `quote-anchor.ts`: resolve a verbatim quote against current file bytes -> block ref (see section 6).
4. `review-ingest.ts`: for each parsed entry, translate to existing ops (`comment.add`, `suggestion.add` from `src/lib/proof/types.ts:115-160`) and apply via `applyOps()` (`src/lib/proof/ops-applier.ts:486`) with `by: "ai:<agent>"`. This reuses revision checks, mutex, event emission, ref resolution, and atomic sidecar writes for free. Track ingested entries by content hash in the sidecar so re-parsing the appended file does not duplicate (see section 4).
5. Watcher: recon confirmed `.proof/` is currently ignored by the shared watcher pool (`src/lib/search/watcher-pool.ts:54` ignore regex includes `\.proof`) and no proof watching exists (recon section 2). Add a small dedicated chokidar watcher scoped to `.proof/**/*.review.md` (do not un-ignore `.proof` globally; that would flood the search indexer). On change (debounced), run ingest. Browser refresh rides the existing proof-store HTTP polling (`src/stores/proof-store.ts:50-130`); SSE push for proof events is explicitly out of scope for the viable cut.
6. Note the existing gotcha "Agent paths reject anything under `.proof/`" (AGENTS.md) applies to the agent HTTP API only; the design has the agent writing `.review.md` directly on local disk, which bypasses that guard by construction. No change needed, but tests must confirm the MCP/agent API still rejects `.proof/` paths.

### Phase B: On-demand "request review" trigger

1. UI: a "Request review" action in the file view / ai-panel (`src/components/ai-panel/`) that POSTs to a new route.
2. New route `POST /api/agent/review-request` (session-gated like `/api/wiki/*`): builds the prompt from a template (file path, `.review.md` target path, grammar cheat-sheet, optionally the git diff summary) and calls the guppi injection entrypoint.
3. Guppi side: recon found NO callable entrypoint (recon section 7). Thinnest addition: a local HTTP endpoint in guppi, `POST /api/inject-prompt` with `{ session?, pane?, text }`, implemented via a new `SendKeys()` on `pkg/tmux/client.go` (tmux `send-keys -t <pane> -l <text>` + `Enter`), reusing `PrimaryPaneID()` for pane resolution. This is the top open question / external dependency (section 8).
4. Prompt template lives in `agents/review-prompt.md`, served or inlined by the route.
5. Shippable independently: if guppi endpoint is absent, the route falls back to returning the rendered prompt for copy-paste (still an improvement, and keeps Phase B testable in wiki-viewer alone).

### Phase C: Human -> agent injection

1. When a human adds a comment or suggestion in the existing UI (`comment-thread.tsx` posts `comment.add`/`comment.reply`; `suggestion-card.tsx` accept/reject), an outbound notifier formats a quote-anchored message: file path, verbatim quoted block text (derived from the block ref via the snapshot blocks already in proof-store / server-side via `parseBlocks` + `assignRefs`, `src/lib/proof/blocks.ts:21`, `src/lib/proof/block-refs.ts:31`), and the comment text.
2. Implement server-side, hooked after successful `applyOps` for human-authored comment/suggestion ops (a small dispatch in the `/api/agent/files/<path>` POST handler or an event-tap on emitted events), calling the same guppi `POST /api/inject-prompt`.
3. Add a per-file or global toggle ("notify agent") plus debounce/batching so rapid typing does not spam injections; respect guppi's own cooldown (`.omx/tmux-hook.json` shows `cooldown_ms: 15000` as internal precedent).

## 3. Per-File Changes

### wiki-viewer

Phase A:
- `/home/sil/wiki-viewer/src/lib/proof/review-parser.ts` — NEW. Grammar parser, lenient, returns `{ entries, warnings }`. ~150 LOC.
- `/home/sil/wiki-viewer/src/lib/proof/quote-anchor.ts` — NEW. Quote -> block-ref resolution with normalization + fallback tiers. ~120 LOC.
- `/home/sil/wiki-viewer/src/lib/proof/review-ingest.ts` — NEW. Entry -> ops translation, dedupe ledger, calls `applyOps`. ~150 LOC.
- `/home/sil/wiki-viewer/src/lib/proof/review-watcher.ts` — NEW. Per-workspace chokidar watcher on `<root>/.proof/**/*.review.md`, debounce, calls ingest. ~100 LOC.
- `/home/sil/wiki-viewer/src/lib/proof/types.ts` — additive fields (section 4). ~20 LOC.
- Watcher bootstrap: start `review-watcher` where workspaces come up (mirror `ensureIndexer` pattern from `src/app/api/wiki/watch/route.ts`). ~15 LOC touched.
- `/home/sil/wiki-viewer/agents/wiki-viewer-skill/SKILL.md` (or new `agents/review-grammar.md`) — document grammar. ~60 LOC.

Phase B:
- `/home/sil/wiki-viewer/src/app/api/agent/review-request/route.ts` — NEW. Session-gated, CSRF-checked (per AGENTS.md convention), renders prompt, calls guppi or returns prompt. ~90 LOC.
- `/home/sil/wiki-viewer/agents/review-prompt.md` — NEW template. ~40 LOC.
- `/home/sil/wiki-viewer/src/components/ai-panel/` — "Request review" button + copy-fallback UI, one component. ~80 LOC.
- `/home/sil/wiki-viewer/src/lib/config.ts` — guppi endpoint URL config (env `GUPPI_INJECT_URL` or config.json). ~15 LOC.

Phase C:
- `/home/sil/wiki-viewer/src/lib/proof/review-notify.ts` — NEW. Format quote-anchored outbound message, debounce, POST to guppi. ~100 LOC.
- `/home/sil/wiki-viewer/src/app/api/agent/files/[...path]/route.ts` (exact path per repo layout) — post-apply hook for human ops. ~20 LOC touched.
- Toggle UI in ai-panel. ~40 LOC.

### guppi/termyard (external repo, /home/sil/guppi)
- `pkg/tmux/client.go` — add `SendKeys(paneID, text string)` wrapping `tmux send-keys -l`. ~30 LOC.
- New HTTP handler `POST /api/inject-prompt` (target resolution, allowlist, cooldown, logging in the existing `.omx/logs` jsonl style). ~120 LOC. Location of guppi's HTTP server mux is an open question (recon did not map it).

Total: ~900 LOC wiki-viewer + ~150 LOC guppi, plus tests.

## 4. Data Model

### `.review.md` grammar (append-friendly, quote-anchored)

```
## review-entry
file: docs/notes.md          (optional inside per-file sibling; the sibling path already implies it)
kind: comment | replace | insertAfter | insertBefore | delete
quote:
> verbatim lines copied from the current file
text: |                       (comment body, for kind=comment)
with: |                       (replacement/insert markdown, for suggestion kinds)
```
Exact syntax to be finalized in Phase A step 1; requirements: line-oriented, no nesting, each entry starts at a `## review-entry` heading so appends never invalidate prior entries, and unknown keys are ignored (lenient).

### Type additions (all additive, no schema-version break)

In `/home/sil/wiki-viewer/src/lib/proof/types.ts`:
- `Comment.quote?: string` — the original verbatim quote that anchored this comment (provenance/debug; `ref` remains the canonical anchor, per existing model at types.ts:1-160).
- `Suggestion.quote?: string` — same. `Suggestion.basis` already exists as optional provenance (recon section 1); evaluate reusing `basis` before adding `quote` — decide during implementation, prefer whichever avoids a new field.
- `Sidecar.reviewIngest?: { fileHash: string; entryHashes: string[] }` — dedupe ledger so re-parsing an appended `.review.md` skips already-ingested entries. Optional field: old sidecars unaffected.
- Optional new op passthrough: none needed — quote is resolved to a block `ref` BEFORE calling `applyOps`, so the existing `comment.add`/`suggestion.add` ops are used unchanged. This is the key reuse decision: the quote anchor is a resolution-time input, not a stored anchor type. `refAliases` rename tracking (`src/lib/proof/block-refs.ts:78`) then keeps it stable like any other ref.

Unresolvable quotes (see section 6) are recorded as a `Comment` with `stale: true` semantics? No — `stale` has an existing meaning (orphaned by raw edit, types.ts). Instead: attach the comment to the whole document is not supported by the current model; record it as a parser warning event only. Whether to surface warnings as a synthetic event type (`review.entrySkipped`) in the sidecar events array is a minor additive choice; recommended yes, so the existing activity feed (`src/app/api/agent/activity/route.ts`) shows it.

## 5. Guppi Integration Contract

Recon finding (section 7): **no callable entrypoint exists.** `pkg/tmux/client.go` has pane listing/capture but no `SendKeys`; the tmux-hook is internal, fixed-pane, and its logs show zero successful injections. This is the top open question.

Proposed thinnest contract (to be added to guppi):

```
POST http://127.0.0.1:<guppi-port>/api/inject-prompt
{ "target": { "type": "session"|"pane", "value": "<name-or-id>" } | null,  // null => configured default / PrimaryPaneID
  "text": "<prompt>",
  "source": "wiki-viewer" }
-> 200 { "sent": true, "pane": "%2" }
-> 409 { "sent": false, "reason": "cooldown" | "target_not_found" }
```

Constraints, mirroring existing hook config (`/home/sil/guppi/.omx/tmux-hook.json`): honor `cooldown_ms`, `max_injections_per_session`, `skip_if_scrolling`, and log to the `.omx/logs/*.jsonl` stream with `source: "wiki-viewer"`. Bind localhost-only; shared-secret header if guppi already has one (unknown — open question). wiki-viewer reads the URL from config (`GUPPI_INJECT_URL`); if unset, Phase B/C degrade to copy-to-clipboard fallback.

How wiki-viewer knows WHICH pane hosts the agent for a given file/workspace: not derivable from recon. Simplest v1: guppi's configured default target, no mapping (single-agent assumption). Mapping agent-id -> pane is deferred (open question).

## 6. Quote-Anchor Resolution + Staleness Rules

Resolution pipeline (in `quote-anchor.ts`), against current file bytes at ingest time, inside the same flow that ends in `applyOps` (so the ref is resolved against exactly the revision being mutated):

1. Parse current markdown into blocks and refs: `parseBlocks` (`src/lib/proof/blocks.ts:21`) + `assignRefs` (`src/lib/proof/block-refs.ts:31`), same machinery ops-applier uses.
2. Tier 1 — exact: find the block whose `blockToMarkdown` output contains the quote verbatim (byte-for-byte after only trailing-newline trim). Unique match -> that block's ref.
3. Tier 2 — normalized: retry with whitespace-collapsed comparison (collapse runs of spaces/tabs, trim lines). Unique match -> ref, and store the entry as matched-normalized (fine; the ref is what persists).
4. Multiple matches: pick none automatically only if truly ambiguous across different blocks; if the quote appears in exactly one block (even multiple times inside it), that block wins, since anchoring granularity is the block. If ambiguous across blocks: unresolved.
5. Multi-block quotes: if the quote spans block boundaries, anchor to the FIRST block whose text starts the quote (documented behavior); suggestions with multi-block quotes are downgraded: `replace`/`delete` spanning blocks -> unresolved (record warning), because `Suggestion.ref` targets a single block (types.ts).
6. Unresolved: skip with warning; emit `review.entrySkipped` event carrying the quote head (first ~80 chars) so the user sees why in the activity feed. Never guess by fuzzy similarity in v1.

Staleness after ingest: nothing new. Once resolved to a block ref, the entry is an ordinary `Comment`/`Suggestion`; existing mechanisms apply — `refAliases` survive one generation of block rename (`block-refs.ts:78`), and raw overwrites that orphan the ref set `stale: true` via the existing reconcile path (recon section 1, `ops-applier.ts:486` external-edit branch). The quote itself is provenance only and is never re-resolved.

Idempotency/races: ingest runs under the same per-file mutex as all ops (`withFileMutex` inside `applyOps`); if `applyOps` returns `409 STALE_REVISION` (external edit detected mid-ingest), re-read and retry once with the fresh snapshot; entries already in the `entryHashes` ledger are skipped on any re-run.

## 7. Test Plan (src/tests/proof/, tsx node:test, run via pnpm test)

New files:
- `review-parser.test.ts` — grammar happy path per kind; malformed entry skipped with warning while later entries still parse; unknown keys ignored; empty file; append-then-reparse yields stable entry hashes.
- `quote-anchor.test.ts` — exact match; normalized-whitespace match; ambiguous across blocks -> unresolved; quote not present -> unresolved; multi-block quote anchors to first block for comments, unresolved for replace/delete; duplicate quote within one block resolves.
- `review-ingest.test.ts` — end-to-end: write file + `.review.md`, ingest, assert `Comment`/`Suggestion` appear in sidecar via `readSidecar` with correct `ref`, `by: "ai:..."`, events emitted; dedupe on second ingest; STALE_REVISION retry path; unresolved entry emits skip event and does not mutate comments.
- `review-watcher.test.ts` — chokidar picks up create + append of `.review.md`, debounces, triggers ingest; non-review files under `.proof/` ignored.

Extended files:
- `comments-ops.test.ts` / `suggestion-ops.test.ts` — assert optional `quote` field roundtrips and is ignored by existing paths (backward compat).
- `reconcile-sidecar.test.ts` — ingested (quote-originated) comments go stale exactly like UI-originated ones after raw overwrite.
- `routes.test.ts` — Phase B route: auth-gated, CSRF Origin check, prompt-fallback when `GUPPI_INJECT_URL` unset; agent API still rejects `.proof/` paths.

Guppi tests are out of this repo's scope; the contract is validated in wiki-viewer by mocking the inject endpoint.

## 8. Risks + Open Questions (ranked)

1. **[Blocker, external] No guppi injection entrypoint exists** (recon section 7: no `SendKeys`, hook logs show zero successful injections ever, `target_not_found`). Phases B/C depend on new guppi work; even guppi's internal targeting is currently broken. Mitigation: Phase A + copy-paste fallback ship without it.
2. **[Open question] Agent/pane mapping**: how does wiki-viewer address the right tmux pane per workspace/agent? V1 assumes single configured target; multi-agent routing undesigned.
3. **[Open question] Guppi HTTP server surface**: recon did not establish whether guppi runs an HTTP server to hang `/api/inject-prompt` on, nor its auth story. Needs a guppi-side recon pass before Phase B.
4. **[Risk] Injection safety**: injecting mid-generation into a live agent session can corrupt its input; mimic hook's `skip_if_scrolling`/cooldown, but "agent is idle" detection is unsolved.
5. **[Risk] Quote ambiguity in repetitive documents** (identical paragraphs/list items). Mitigated by block-granularity uniqueness rule + skip-with-warning; residual UX cost: agent must quote more context.
6. **[Risk] Watcher/ingest vs. simultaneous agent edits**: agent may append `.review.md` while also editing the source file; STALE_REVISION retry handles it, but a pathological edit storm could starve ingest. Debounce + single retry + warning covers v1.
7. **[Open question] `.review.md` lifecycle**: truncate/archive after ingest, or leave append-only forever? Recommendation: leave in place, rely on `entryHashes` ledger; revisit if files grow. Not resolvable from recon.
8. **[Minor] Proof updates still reach the browser only by polling** (recon section 2). Acceptable for v1; SSE push for proof events is a known deferred enhancement.
9. **[Reuse decision] `Suggestion.basis` vs new `quote` field** — resolve at implementation time; either is additive.

## 9. Effort Estimate

- Phase A: 4-5 days (parser + resolver + ingest + watcher + ~4 test files; the heavy lifting reuses `applyOps`).
- Phase B: 2-3 days wiki-viewer side + 1-2 days guppi side (assuming guppi has an HTTP server to extend; +1-2 days if not — open question 3).
- Phase C: 2 days (notifier + hook + toggle + tests).

Total: ~9-12 working days. The parent standing estimate of 1-2 weeks is **validated for the wiki-viewer work**, with the caveat that guppi-side unknowns (open questions 1-3) could push the full three-phase loop toward the top of that range or slightly past it. Phase A alone (the viable cut) is comfortably under one week.

### Critical Files for Implementation
- /home/sil/wiki-viewer/src/lib/proof/ops-applier.ts - `applyOps()` at line 486 is the single reuse point for ingest (mutex, revision, events, atomic writes)
- /home/sil/wiki-viewer/src/lib/proof/types.ts - additive `quote` / `reviewIngest` fields on Comment/Suggestion/Sidecar
- /home/sil/wiki-viewer/src/lib/proof/block-refs.ts - `assignRefs`/`resolveRef` power quote-to-ref resolution and downstream staleness
- /home/sil/wiki-viewer/src/lib/search/watcher-pool.ts - existing chokidar pattern; `.proof` ignore at line 54 explains why a dedicated review watcher is required
- /home/sil/wiki-viewer/src/app/api/wiki/watch/route.ts - reference pattern for per-workspace watcher bootstrap
