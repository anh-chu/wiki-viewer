# Unified Live — design & contracts

Grounded in recon (2026-08-15). File refs are current.

## Server: markdown proposal store (write-on-accept)
Mirror the web-tweak preview-store transaction, but for markdown. New store `src/lib/proof/live/md-proposal-store.ts` (or extend preview-store with `surface` tag — prefer a separate table to avoid destabilizing shipped web-tweak).

Table `md_proposal`:
- `previewId` (pk), `workspace_id`, `path`, `block_ref`, `base_revision`, `base_block_hash`,
- `request_id`, `state` (requested|ready|resolving|accepted|discarded|invalidated),
- `variants` JSON `[{variantId, label, markdown}]`, `selected_variant_id`,
- `created_at`, `resolved_at`.
Atomic `claimForResolve(previewId)`; drift check compares current block markdown hash to `base_block_hash` under file lock at accept.

### Human routes (UI-only, trusted)
- `POST /api/wiki/live/md-request` → `{path, blockRef, baseRevision, baseBlockHash, instruction, selectionText?, selectionStart?, selectionEnd?}` → creates proposal (state=requested), enqueues live request (kind `generate`, carries `previewId`), returns `{previewId, requestId}`.
- `GET /api/wiki/live/md-status?previewId=` → `{state, variants, selectedVariantId, ...}`.
- `POST /api/wiki/live/md-resolve` → `{previewId, action: accept|discard, variantId?}`. Accept: claim → re-read block, verify hash == base_block_hash (else `invalidated`) → commit chosen variant verbatim via tier-2 `block.replace` at `base_revision` → state=accepted. Discard: claim → state=discarded. **No agent auth accepted here.**

### Agent submit (MCP backend)
Reuse existing `/api/agent/live/*`. Extend the agent web-preview submit concept for markdown, OR add `POST /api/agent/live/md-preview` → `{previewId, requestId, variants:[{variantId,label,markdown}]}` (2–5 variants enforced) → validates ownership/scope, stores variants, state=ready, marks request resolved(working→ready). Data-only (markdown strings); no file write.

## MCP tools (packages/wiki-viewer-mcp)
Delete: `live` subcommand, `runLiveLoop`, `passthroughHandler`, `llmHandler`, `claudePrompt`, `passthroughWebHandler`, `passthroughVariantsHandler`, and loop/reference tests in `live-client.test.ts`. Keep `LiveClient.attach/poll/reply/snapshot/applyTier2Ops` as tool backends.

New tools in `server.ts` + `tool-schemas.ts` + `tool-handlers.ts`:
- `live_attach` → `{sessionId, workspaceId}`.
- `live_poll {sessionId, afterSeq}` → held ~25s; returns next request `{requestId, kind, surface, previewId?, path, blockRef, baseRevision, instruction, selectionText?, ...}` or `{type:"timeout"}`. Model calls it in a loop while attending.
- `live_snapshot {path}` → tier-2 blocks + revision (for finding target block markdown).
- `live_reply {requestId, status}` → working|done|error.
- `live_submit_markdown {previewId, requestId, variants:[{variantId?,label,markdown}]}` → posts to md-preview; enforces 2–5 variants; server derives variantId if absent.
- `live_submit_web {previewId, requestId, variants|domPreviewOps, candidateSourcePatch, baseFiles}` → posts to existing web-preview.

Agent flow (documented in skill): call `live_attach` once → loop `live_poll` → on `generate` markdown request: `live_snapshot`, produce 2–5 rewrites of the target block, `live_submit_markdown`, `live_reply done` → loop. Agent NEVER accepts.

## Client: shared Live overlay + ephemeral markdown preview
- Presence component (new, shared) `src/components/editor/live-presence.tsx`: polls `/api/wiki/live/status`; solid/amber + Connect; grace window.
- Markdown ephemeral preview: integration point `editor.tsx:435-464` (block annotation effect provides `[data-block-ref]` slots + `blockRefPositions`). On proposal `ready`, render selected variant via `markdownToHtml(candidate, {pagePath, sanitize: isViewing})` into an overlay pinned to the target block slot; hide original block visually; cycle = swap candidate; **Accept** → POST md-resolve accept (server commits) then reload snapshot; **Discard** → drop client state only. Never call `editor.commands.setContent` for preview; never write activity/audit provenance for pending preview.
- Target selection reuses `resolveSelectionBlock` (block primary, text-range as context fields).
- Verb/label alignment in `web-tweak-overlay.tsx`: Target/Variant/Proposal/Accept/Discard/Go.

## Delete from live path (client)
`run-review-bar.tsx`, `instruction-queue-bar.tsx`, `instruction-popover.tsx`, activity/audit provenance hover popover + delegation IF no pending-review remains, `onInstruct` in `bubble-menu.tsx` and its editor wiring, `draftInstructions`/`sentInstructions` state. Keep: `ActivityProvenance` extension, sanitize-schema activity/audit provenance support, `wrapAsActivityProvenance`/`unwrapActivityProvenances`/`revertActivityProvenance` (accepted provenance), server accepted-provenance ops.

## Keep as-is
Tier-2 `/api/agent/files` commit path (stale/idempotency), web-tweak resolve/status/picker routes, content-clock revision, block-ref frontmatter offset fix, filesystem MCP tools.

## Test floor
Current floor 693–694. Replace deleted live/loop tests with: md-proposal store lifecycle (requested→ready→accept commits verbatim / discard leaves file identical / invalidated on drift), MCP tool-handler tests, presence honesty. Keep suite green.
