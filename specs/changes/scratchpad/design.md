# Scratchpad — Design

## Overview

Scratch content is stored as hidden files under `<workspace-root>/.scratch/`
and opened through the existing open-file pipeline, so all viewers/editors work
unchanged. Only two genuinely new pieces: a server route to create/cleanup
scratch files, and client UI to capture paste/drop/URL and open the result.

## Storage

- Directory: `.scratch/` at the workspace root (hidden, not a denied segment).
- Filenames: `scratch-<epochMs>-<rand6>.<ext>`.
- Reachable by `/api/wiki/content` (text edit/read) and `/api/assets` (binary
  viewers) because it lives inside the root and `.scratch` is not denied.
- Containment via existing `resolveWorkspacePath`. We do NOT add `.scratch` to
  `DENIED_SEGMENTS` (that list stays `[".proof", ".git"]`); scratch paths are
  normal reachable paths.

## Server: `POST /api/wiki/scratch`

New route `src/app/api/wiki/scratch/route.ts`. CSRF + `resolveWorkspaceForUser(..,"write")`.

Two request shapes:

1. **Text** — `Content-Type: application/json`
   Body `{ ext: string, content: string }`.
   - Sanitize `ext` (alphanumeric, length-capped; fallback `txt`).
   - Compute `rel = .scratch/scratch-<ts>-<rand>.<ext>`.
   - `resolveWorkspacePath(root, rel, { allowMissing: true, deniedSegments: [".proof",".git"] })`.
   - mkdir `.scratch`, write UTF-8.
   - Return `{ path: rel, name }`.

2. **Binary** — `Content-Type: multipart/form-data`
   Field `file`.
   - Derive extension from the uploaded filename (sanitized).
   - Size cap (reuse the 50MB upload ceiling).
   - Write `Buffer` bytes (not UTF-8) to `.scratch/...`.
   - Return `{ path, name }`.

On every POST, run a **TTL sweep**: delete `.scratch` entries older than
`SCRATCH_TTL_MS` (default 7 days) before creating the new one. Best-effort;
ignore per-file errors.

Server-start sweep: add a call in `src/instrumentation.ts` (or the existing
startup hook) to purge stale scratch files across known workspace roots. If a
per-root registry isn't cheaply available at startup, the POST-time sweep is the
primary mechanism and the startup sweep is best-effort over the seeded root.

## Text sniffing (client)

Helper `src/lib/scratch/detect.ts`:

```
detectScratchExt(text): "html" | "md" | "txt"
```

- HTML if it matches a leading `<!doctype html`, `<html`, or has multiple
  balanced tags near the start.
- Markdown if it has md signals (`^#{1,6} `, `](`, ```` ``` ````, `- ` lists).
- Else `txt`.

Code paste: v1 does not language-classify; unknown code lands in `.txt` and the
source viewer sniffs. (A future enhancement could offer an explicit language
picker.) The "code with syntax view" criterion is met because the source viewer
already renders and syntax-handles arbitrary text, and the user can rename via
"Save to real file" with a chosen extension.

## Client entry points

`src/hooks/use-scratchpad.ts` — orchestrates create+open. Exposes:

- `openCreateSurface()` — reveals the create UI.
- `createFromText(text)` — sniff, POST text, open resulting path.
- `createFromFile(file)` — POST multipart, open resulting path.
- `openUrl(url)` — open the website viewer at an external URL (no file).
- `promote(destPath)` — move scratch → real path, reopen.

Wiring in `src/app/page.tsx`:

- Keyboard: `keydown` listener for Cmd/Ctrl+Shift+N → `openCreateSurface()`.
- Button: add a scratchpad button near the existing new-file affordance
  (header or sidebar).
- Drop: the empty-viewer state (`page.tsx` "Select a file" block) becomes a
  drop target; dropping a file calls `createFromFile`.

## Create surface UI

`src/components/wiki/scratchpad-create.tsx` — replaces the empty-viewer
placeholder when active. Three quick inputs:

- A large textarea: "Paste or type…" → on paste/submit calls `createFromText`.
- A URL input: "Open a link…" → `openUrl`.
- A drop zone / file button → `createFromFile`.

After creation, the surface closes and the normal `ViewerPane` renders the
opened scratch file.

## Opening the created scratch

Reuse `useOpenFile.openViewer` via a synthesized `TreeNode`:
`{ path, name, type: "file", modifiedAt: "" }`. This runs the exact same code
path as clicking a file in the tree, so markdown → editor-store, binary →
native viewer.

## Web URL viewing (no file)

`OpenFile` gains an optional field `externalUrl?: string`. When set:

- `viewer-pane.tsx`: for the website/html branch, prefer `openFile.externalUrl`
  as the iframe `src` when present (bypassing `/api/assets`).
- `use-open-file.ts`: add an `openExternalUrl(url)` that sets
  `openFile = { path: "", name: url, nodeType: "app", externalUrl: url }` and
  forces the website viewer. Keep it minimal; no file written.

This is the only change to existing viewer code and it is additive/optional.

## Promote to real file

Reuse `POST /api/wiki/move` (`from = scratchRel`, `to = destRel`). Add a
"Save to real file…" action in the viewer toolbar/menu, visible only when the
open file's path starts with `.scratch/`. It opens a destination picker
(reuse `DirPicker`/new-file naming), calls move, then reopens `destRel`.

## Files touched

New:
- `src/app/api/wiki/scratch/route.ts`
- `src/lib/scratch/detect.ts`
- `src/lib/scratch/config.ts` (TTL, dir name, filename gen)
- `src/hooks/use-scratchpad.ts`
- `src/components/wiki/scratchpad-create.tsx`
- `src/tests/proof/scratch.test.ts`

Edited (small, additive):
- `src/types/wiki.ts` — `OpenFile.externalUrl?`
- `src/hooks/use-open-file.ts` — `openExternalUrl`, expose promote/open helpers
- `src/components/wiki/viewer-pane.tsx` — external URL src + "Save to real file"
- `src/app/page.tsx` — shortcut, button, empty-viewer drop, render create surface
- `src/instrumentation.ts` — startup sweep (best-effort)

## Alternatives rejected

- **In-memory docs**: rewrites every viewer; disproportionate risk.
- **OS temp dir outside workspace**: viewers fetch by workspace-relative path;
  files outside the root are unreachable and would violate containment.
- **`.scratch` as denied segment**: would make scratch files unreachable by the
  very viewers we need. So it stays reachable, protected only by root containment.

## Security notes

- All writes go through `resolveWorkspacePath`; traversal/symlink escapes
  rejected exactly as other routes.
- Binary writes use raw buffers, avoiding UTF-8 corruption.
- Website viewer keeps its existing sandbox; external URLs get no extra powers.
- Scratch files are subject to the same auth/workspace scoping as any file.
