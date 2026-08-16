# Tweak Unification: Design

## Shared module

A new directory `src/components/editor/tweak/` holds the shared feature module:

- `tweak-types.ts`
  - `TweakItem { itemId; targetKey; displaySnippet; instruction }`
  - `TweakVariant`
  - `TweakPhase`
  - `ContentKindAdapter` interface

- `use-tweak-session.ts`
  - Shared hook that owns the queue model, dispatch lifecycle, status polling, presence gate, and accept/discard resolution.
  - Generic over an adapter.

- `tweak-queue-bar.tsx`
  - Shows the count, a per-item remove, and a cancel/deselect control.
  - Dispatch button label comes from the adapter (Rewrite or Apply).

- `tweak-overlay.tsx`
  - Shared shell: targeting UI, queue bar, and variant preview/cycle/accept/discard.
  - Delegates content rendering to the adapter.

- `adapters/markdown-adapter.ts`
  - `resolveSelectionBlock` target resolution.
  - `markdownToHtml` preview.
  - `dispatchLabel` "Rewrite".

- `adapters/html-adapter.ts`
  - `postMessage` element picker.
  - DOM-op preview.
  - `dispatchLabel` "Apply".

## Thin mounts

`live-overlay.tsx` and `web-tweak-overlay.tsx` become thin mounts of `TweakOverlay` with the respective adapter.

## Dedup

`addItem` dedups by `targetKey`:

- Markdown: `blockRef`.
- HTML: picker `pick.id`, falling back to the selector.

## Markdown batching

Markdown batching reuses the shared live store and `POST /api/wiki/live/request`. The only genuine server change is:

- Optional per-item `blockRef`, `baseRevision`, and `baseBlockHash` fields.
- Markdown `itemPreviews[]` on the submit path.

## Alternatives rejected

- Looping the md-request N times: trips 409 serialization.
- Inventing a parallel markdown batch route: needless duplication.
