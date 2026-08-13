# Scratchpad — Proposal

## Problem

Viewing or editing arbitrary content today requires creating a real file first:
pick a folder, name it, choose an extension, then open it. For quick throwaway
work (paste a log, preview some HTML, skim a PDF, check a URL, jot markdown)
that ceremony is friction and pollutes the workspace with junk files.

## Desired outcome

A "scratchpad": one shortcut/button that opens an instant view+edit surface.
Drop or paste anything (text, markdown, HTML, code, CSV, PDF, images, office
docs) or a web URL, and it renders immediately in the existing viewer/editor
with no manual file creation. Optionally promote a scratchpad to a real file
with one click.

## Chosen approach (decided with user)

**Hidden temp files inside the workspace.** Scratch content is written to a
hidden `.scratch/` directory at the workspace root, then opened through the
normal open-file pipeline. This reuses every existing viewer/editor unchanged
(all viewers already fetch by workspace-relative path via `/api/wiki/content`
and `/api/assets`). No viewer rewrite, low risk.

Rejected: true in-memory (no-fs) docs — every viewer only accepts a `path` and
fetches server bytes; supporting inline content/blobs would require rewriting
CSV/PDF/image/docx/xlsx/pptx/html/source viewers and the editor-store save
path. Weeks-scale, high regression risk, out of proportion to the value.

## Scope

- New hidden `.scratch/` workspace dir holding scratch files.
- Scratchpad entry points: keyboard shortcut (Cmd/Ctrl+Shift+N), sidebar/header
  button, and drop-file-on-empty-viewer.
- Create-scratch flow: paste text (auto-detect md/html/code by sniffing),
  markdown editing, HTML preview, code with syntax view, drop any file type,
  and open a web URL in the website viewer.
- Ephemeral by default with a one-click "Save to real file" (promote) action.
- Cleanup of stale scratch files.

## Non-goals

- No true in-memory / zero-fs rendering.
- No multi-tab scratchpad manager UI in v1 (one active scratch at a time is
  fine; multiple scratch files may coexist on disk but no dedicated manager).
- No collaboration/sidecar/proof provenance for scratch markdown beyond what
  the normal editor already does.
- No sharing of scratch files via public share links in v1.
- No sync of scratch content across devices/servers.

## Risks

- **Containment.** `.scratch/` must stay inside the workspace and never escape.
  Mitigated: reuse `resolveWorkspacePath`; add `.scratch` handling that keeps it
  a normal (reachable) segment, not a denied one.
- **Clutter/leaks.** Scratch files accumulate. Mitigated: hidden dir + age-based
  cleanup on server start and on scratch open.
- **Tree noise.** `.scratch/` shows in the file tree when "show hidden" is on.
  Acceptable; it is a real hidden dir.
- **Binary via URL.** Dropped binary files (pdf/image/docx) must be written
  byte-accurately, not as UTF-8 text. Mitigated: use the upload/binary write
  path, not the text content PUT.
- **Web URL viewing.** Cross-origin iframes may refuse to load (X-Frame-Options).
  Acceptable: show the same sandboxed iframe the website viewer already uses;
  failures are the remote site's choice, surface a fallback "open in new tab".

## Acceptance criteria

1. A shortcut and a visible button both open a scratchpad create surface.
2. Pasting markdown/HTML/code opens the correct viewer/editor instantly with no
   manual filename step.
3. Dropping a file (pdf, png, csv, docx) on the empty viewer opens it in its
   native viewer.
4. Entering a web URL opens it in the website viewer.
5. Scratch files live under `.scratch/` and are reachable by all viewers.
6. "Save to real file" moves/copies a scratch file to a user-chosen workspace
   path and reopens it there.
7. Scratch files are never written outside the workspace root; traversal and
   symlink escapes are rejected.
8. Stale scratch files are cleaned up automatically.
9. `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass (test floor held).
