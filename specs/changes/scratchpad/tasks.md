# Scratchpad — Tasks

Ordered, checkable. Mark complete only after verification.

## Backend

- [ ] T1. `src/lib/scratch/config.ts`: `SCRATCH_DIR = ".scratch"`,
      `SCRATCH_TTL_MS`, `newScratchName(ext)`, `sanitizeExt(ext)`.
- [ ] T2. `src/lib/scratch/detect.ts`: `detectScratchExt(text)` → html|md|txt.
- [ ] T3. `src/app/api/wiki/scratch/route.ts`: POST text + multipart, containment
      via `resolveWorkspacePath`, TTL sweep, returns `{ path, name }`.
- [ ] T4. Startup sweep hook in `src/instrumentation.ts` (best-effort).

## Types + open pipeline

- [ ] T5. `src/types/wiki.ts`: add `OpenFile.externalUrl?: string`.
- [ ] T6. `src/hooks/use-open-file.ts`: `openExternalUrl(url)`, and a
      `openScratchByPath(path)` that opens a synthesized TreeNode. Expose a
      `promoteScratch(destPath)` that calls `/api/wiki/move` then reopens.

## Viewer

- [ ] T7. `src/components/wiki/viewer-pane.tsx`: use `openFile.externalUrl` as
      iframe `src` when present; add "Save to real file…" menu item shown only
      for paths under `.scratch/`.

## Client UI

- [ ] T8. `src/hooks/use-scratchpad.ts`: create surface state + create/open/promote.
- [ ] T9. `src/components/wiki/scratchpad-create.tsx`: paste textarea, URL input,
      drop zone/file button.
- [ ] T10. `src/app/page.tsx`: Cmd/Ctrl+Shift+N shortcut, scratchpad button,
      empty-viewer drop target, render create surface when active.

## Tests + gates

- [ ] T11. `src/tests/proof/scratch.test.ts`: text create, binary create,
      traversal rejection, TTL sweep, promote via move.
- [ ] T12. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`; hold/raise floor.
- [ ] T13. Manual smoke: paste md/html/code, drop pdf+png+csv, open URL, promote.

## Docs

- [ ] T14. Note scratchpad in README/AGENTS if user-facing behavior needs it.
- [ ] T15. Archive spec to `specs/changes/archive/<date>-scratchpad/` on close.
