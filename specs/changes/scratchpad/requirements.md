# Scratchpad — Requirements

Each requirement is observable behavior.

## R1 — Open scratchpad create surface

GIVEN the app is loaded
WHEN the user presses Cmd/Ctrl+Shift+N OR clicks the scratchpad button
THEN a scratchpad create surface appears without selecting an existing file.

## R2 — Paste text auto-detected

GIVEN the scratchpad create surface is open
WHEN the user pastes text
THEN the type is sniffed (HTML if it looks like HTML, markdown if md-ish,
     otherwise plain/code) and a scratch file with the matching extension is
     created and opened in the correct viewer/editor.

## R3 — Markdown editing

GIVEN a scratch `.md` file is opened
WHEN the user edits it
THEN it behaves like any markdown page (TipTap editor, autosave to the scratch
     file), with revision tracking as normal.

## R4 — HTML preview

GIVEN pasted or dropped HTML content
WHEN the scratch `.html` file is opened
THEN it renders in the sandboxed website viewer, with the existing
     source/preview toggle available.

## R5 — Code with syntax view

GIVEN pasted code (e.g. `.ts`, `.py`, or unknown → `.txt`)
WHEN the scratch file is opened
THEN it opens in the source viewer with syntax handling and is editable.

## R6 — Drop a file on empty viewer

GIVEN no file is open (empty viewer state)
WHEN the user drops a file (pdf, png, csv, docx, xlsx, pptx, md, txt, ...)
THEN the bytes are written to a scratch file preserving the original extension
     and the file opens in its native viewer.

## R7 — Web URL viewing

GIVEN the scratchpad create surface
WHEN the user enters an http(s) URL and submits
THEN it opens in the website viewer pointed at that URL (sandboxed iframe), with
     an "open in new tab" fallback.

## R8 — Scratch storage location

GIVEN any scratch is created
WHEN it is written
THEN it lives under `<workspace-root>/.scratch/` with a generated unique name,
     reachable by `/api/wiki/content` and `/api/assets`.

## R9 — Promote to real file

GIVEN a scratch file is open
WHEN the user clicks "Save to real file" and picks a destination path
THEN the scratch content is written to that workspace path, the scratch file is
     removed, and the viewer reopens the new real file.

## R10 — Containment

GIVEN any scratch create/promote request
WHEN a path would traverse (`..`), be absolute, or escape via symlink
THEN the request is rejected (400) and nothing is written outside the workspace.

## R11 — Cleanup

GIVEN scratch files older than a TTL exist
WHEN the server starts OR a new scratch is created
THEN stale scratch files (and their sidecars, if any) are deleted.

## R12 — Quality gates

GIVEN the change is complete
WHEN `pnpm typecheck`, `pnpm lint`, and `pnpm test` run
THEN all pass and the test floor is held or raised.
