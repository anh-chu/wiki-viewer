# Tweak Unification: Tasks

## Chunk A (server/store batch)

- [x] A1 Extend `LiveInstructionItem` and `/api/wiki/live/request` with optional markdown fields; validate 1..N items.
- [x] A2 Accept markdown `itemPreviews[]` in the md-preview submit path and in `md-proposal-store`.
- [x] A3 Store and route unit tests.

## Chunk C (copy/labels)

- [x] C1 Rename `ai-panel.tsx` copy.
- [x] C2 Rename `website-viewer.tsx` toggle strings and tooltips.

## Chunk B (shared client module, after A)

- [x] B1 Create `src/components/editor/tweak/*` with dedup and deselect.
- [x] B2 Reduce `live-overlay.tsx` to a `TweakOverlay` mount (markdown adapter, Rewrite, always gather).
- [x] B3 Reduce `web-tweak-overlay.tsx` to a `TweakOverlay` mount (html adapter, Apply).
- [x] B4 `bubble-menu.tsx` tooltips and `onLive` -> `onTweak` rename; `view-mode-comment-button.tsx` "Tweak" label; `editor.tsx` mount and `openLiveForSelection` -> `openTweakForSelection`.

## Chunk D (docs + tests, last)

- [x] D1 Update `docs/ux-contracts.md`: rename Go loop -> Tweak loop, document markdown gather/queue plus batch, dedup-by-target, deselect, and Rewrite/Apply.
- [x] D2 Component and integration tests for dedup, deselect, and markdown batch.
- [x] D3 `pnpm typecheck && lint && test` green; floor not reduced.
