# Feature context: comments on code/text files (proof system extension)

Prepared for a feature-light implementation chain. All facts below are grounded in the
current tree (verified, not assumed). Goal: let users comment on **non-markdown text/code
files** (anything rendered by `SourceViewer`), reusing the proof sidecar + comment UI.
**Suggestions stay markdown-only** (they are markdown-block edits by nature — out of scope).

## Scope

- **MVP + line-hash anchoring** (recommended single deliverable).
- Comments anchored to a line range, surviving small edits via line-content hashing;
  orphaned comments fall back to the existing `stale` flag.
- Reply / resolve / reopen reuse existing ops unchanged.
- No new deps, no new routes, no new storage format.

## How the markdown comment flow works today (grounded)

1. **Trigger:** user selects text in the editor. In read-only view,
   `src/components/editor/view-mode-comment-button.tsx` listens to `selectionchange`,
   positions a floating button over the selection.
2. **Anchor resolution (client):** `src/components/editor/editor.tsx` maps the selection to
   a top-level ProseMirror child and reads its `data-block-ref` (editor.tsx ~L391-414).
   Pip positions come from walking `.ProseMirror > *` by index → `blockRefPositions`
   (editor.tsx ~L553-572, rendered ~L1082).
3. **Submit (client):** `comment-thread.tsx` builds the op
   `{ type: "comment.add", ref: blockRef, text }` (comment-thread.tsx:112) and POSTs via
   `postOp()` → `POST /api/agent/files/<path>` with `{ baseRevision, by, ops }`
   (comment-thread.tsx:25-50).
4. **Apply (server):** `src/app/api/agent/files/[...path]/route.ts` → `applyOps()`
   (`src/lib/proof/ops-applier.ts`). `comment.add` calls `resolveRef(sidecar, op.ref, currentRefs())`
   against parsed markdown blocks (ops-applier.ts:489-510). Writes `Comment` into the
   sidecar `comments[]`.
5. **Storage:** `.proof/<path>.json` (`src/lib/proof/sidecar.ts`). `Comment` shape in
   `src/lib/proof/types.ts:38-52` (`id`, `ref`, `resolved`, `turns[]`, `stale?`).
6. **Load (client):** `src/stores/proof-store.ts:32` `loadSidecar()` →
   `GET /api/agent/sidecar/<path>`.

## The coupling points (what blocks non-markdown)

Three server gates reject non-`.md` paths and must be relaxed for text files:

| File                                           | Line               | Gate                                                  |
| ---------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `src/app/api/agent/files/[...path]/route.ts`   | GET ~52, POST ~110 | `if (!isMarkdown(rel)) → 400 INVALID_PATH`            |
| `src/app/api/agent/sidecar/[...path]/route.ts` | ~32                | same                                                  |
| `src/app/api/agent/internal/span/route.ts`     | ~63                | same (AI provenance — NOT needed for comments; leave) |

Plus the **block-ref assumption** in `applyOps`: `comment.add` resolves `op.ref` against
parsed markdown blocks. Non-md comments must take a branch that skips block parsing and
stores a line anchor directly.

And the **renderer gap**: `src/components/editor/source-viewer.tsx` (289 LOC) renders
`<tr>`-per-line HTML via `lowlight`. It has **no** selection→anchor, no pip positioning,
no sidecar load/save, no thread mounting. This is the bulk of the work.

## Reusable as-is

- Sidecar storage + `Comment` type (add one optional field).
- `comment.reply` / `comment.resolve` / `comment.reopen` ops (ops-applier.ts:513-557) —
  anchor-agnostic, no change.
- `CommentThread` (comment-thread.tsx, 254 LOC) — takes `path` + an anchor + text; minor
  prop change to accept a line anchor instead of `blockRef`.
- `CommentPip` (comment-pip.tsx, 56 LOC) — pure presentational, positioned by `top`/`left`
  pixels; rename `blockRef` prop to a generic key.
- `proof-store`, event log, SSE reload.

## Data model addition (`src/lib/proof/types.ts`)

```ts
export interface LineAnchor {
  lineStart: number;     // 1-based
  lineEnd: number;
  textHash: string;      // sha256(first 12 hex) of the anchored line(s), for drift detection
}
// On Comment: make `ref` optional and add:
lineAnchor?: LineAnchor;
```

`comment.add` op gains optional `lineAnchor`; when present, server skips `resolveRef`.

## Line-hash staleness (the +drift portion)

On sidecar load for a text file: for each comment, recompute the hash at `lineStart..lineEnd`.
If mismatch, search ±3 lines for a matching hash and re-point; if none, set `stale = true`
(flag already exists, already rendered by the UI). No diff engine.

## Estimate

- **Net ~250–350 LOC across 6–7 files.** No new deps/routes.
- Dominant cost: `source-viewer.tsx` (~120–180 LOC, ~half the diff) — it has zero comment infra.
- MVP-without-drift ≈ ~180 LOC; line-hash adds ~100–150.

Per-file:

| File                                                           | Change                                                                        | ~LOC     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `src/components/editor/source-viewer.tsx`                      | line-click anchor, line→y map, mount pips+thread, sidecar fetch/save          | +120–180 |
| `src/lib/proof/ops-applier.ts`                                 | non-md `comment.add` branch (skip `resolveRef`) + line-hash reconcile on read | +50–70   |
| `src/lib/proof/types.ts`                                       | `LineAnchor` + optional `lineAnchor` on `Comment`                             | +10      |
| `src/app/api/agent/files/[...path]/route.ts`                   | allow text paths for comment ops                                              | +10–20   |
| `src/app/api/agent/sidecar/[...path]/route.ts`                 | allow text paths                                                              | +5       |
| `src/components/editor/comment-thread.tsx` + `comment-pip.tsx` | accept line anchor                                                            | +15–25   |
| `src/stores/proof-store.ts`                                    | load sidecar for non-md path                                                  | +10      |

## Constraints / guardrails

- **Do not** enable suggestions for non-md — only comment ops. The `files` route must still
  reject suggestion ops on text paths (only loosen the path gate for comment-type ops, or
  gate by op type).
- Keep the `.proof/` path-traversal rejection intact (files route ~L50/108).
- Reuse `withFileMutex` + revision/staleness path already in the route — no parallel locking.
- Markdown path behavior must not change (block-ref flow stays default when `lineAnchor` absent).

## Open decisions (resolve before/at plan step)

1. **Anchor granularity:** single line vs line range. Range is barely more code and better UX;
   recommend range.
2. **Which text files:** all `SourceViewer`-rendered files, or a whitelist? Recommend all
   text files (binary already falls back to `FileFallbackViewer`).
3. **Op-type gating:** relax the route's md-gate only for `comment.*` ops (cleanest), vs relax
   path gate wholesale. Recommend op-type gating to keep suggestions out.

## Suggested chain shape

1. **Plan** (read this doc) → produce concrete diffs/signatures, resolve the 3 open decisions.
2. **Implement** server (types + ops-applier branch + route gates) and client
   (source-viewer + thread/pip props + store) — can parallelize server vs client.
3. **Review** — verify markdown flow unchanged, suggestions still rejected on text paths,
   `pnpm tsc --noEmit` + `pnpm build`, line-hash drift behaves.
