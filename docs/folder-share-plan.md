# Public folder shares

Status: implemented (v1). Owner-facing behavior is recorded in `docs/ux-contracts.md` §12.

## Goal

A signed-in user publishes one folder as a public, read-only link. The visitor needs no
account. The link exposes that folder and its descendants, and nothing else.

## Non-goals (v1)

- No write, comment, or suggestion surface for visitors.
- No search, no recursive archive download, no "download all".
- No per-visitor identity, audit trail, or account.
- No nested shares: one folder share has one root path. Subfolders are not separately shareable
  from inside the visitor view.
- No dotfiles. Any path segment that starts with `.` is refused for listing, content, and bytes.

## Data

`shared_docs` gains `kind TEXT NOT NULL DEFAULT 'file'` with values `file` or `dir`.
On first open the store reads `PRAGMA table_info(shared_docs)` and runs
`ALTER TABLE shared_docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'file'` when the column is
absent. Existing rows therefore become file shares.

`file_path` holds the shared path for both kinds. For a folder share it is the folder, and that
folder is the share root.

## HTTP surface

Every share route stays public and token-gated. A password-protected share keeps the existing
unlock cookie, whose `Path` is the token path, so nested requests carry it unchanged.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/share` | Create a share for a file or a folder. The kind is inferred from `stat` on the target; directories are no longer rejected. The response adds `kind`. |
| GET | `/api/share/<token>` | Without `path`: the share root. With `?path=<rel>`: that path inside the share. A file returns `{kind:"file", content, filename, path, filePath, viewCount}`. A folder returns `{kind:"dir", path, entries[], truncated, viewCount}`. |
| POST | `/api/share/<token>` | Unlock a protected share (unchanged); also returns the folder listing for a folder share. |
| GET | `/api/share/<token>/asset?path=<rel>` | Raw bytes of a file inside the share. Without `path`, unchanged: the shared file itself. |

`entries[]` is `{name, path, isDir, size}`, sorted directories first and then by case-insensitive
name. `truncated` is true past 2000 entries.

`path` in responses is always relative to the share root, so no path above the share root leaves
the server. File shares keep the previous `filePath` value for compatibility; folder shares use
the share-relative path there.

## Containment

Two steps, both required:

1. Resolve the share root with the existing `safeAbsPath(ws.rootDir, share.filePath)`.
2. Resolve every request path with
   `resolveWorkspacePath(shareRootAbs, rel, { deniedSegments: [".proof", ".git"] })`.

Rooting step 2 at the share folder is what keeps a `?path=` request inside the share. The
`realpath` checks inside `resolveWorkspacePath` reject symlink escapes, and its normalizer
rejects absolute paths and `..`.

## Rate limits

`checkAndConsume` gains an optional `bucketSize`, defaulting to `OPS_PER_MINUTE`. Listing and
content stay on `share:<token>` (60 per minute). Nested assets use `share-asset:<token>` with a
600 per minute bucket, because one folder page can load many images. Ceiling: a bucket keeps the
size it was first created with.

## Markdown relative URLs

`markdownToHtml` gains `relativeBases?: { asset: string; page: string }`:

- `src` and `data-src` resolve to `${asset}?path=<share-relative path>`
- `href` resolves to `${page}?path=<share-relative path>`

The share viewer passes `{ asset: "/api/share/<token>/asset", page: "/s/<token>" }` and a
`pagePath` relative to the share root. The render cache key includes both bases. Without the
option the existing `/api/assets/*` behavior is unchanged.

## User interface

- **Creation.** The file-tree context menu gains **Share folder** on directory rows. The viewer
  toolbar Share button keeps sharing the open file. Both set
  `dialogs.shareTarget = { path, type }`; the dialog reads that and adjusts its wording
  ("folder" compared with "document").
- **Visitor page** `/s/<token>`. A folder share shows a breadcrumb and an entry list. Selecting a
  file loads it in the existing viewers. `?path=` stays in the URL so a file link is copyable.
- The content viewer builds asset URLs with the share-relative path.

## Acceptance gates

- **G1** `pnpm typecheck` — clean.
- **G2** `pnpm test` — pass count does not drop below `.test-floor`. New tests cover: folder
  share creation; a directory listing; nested file content; nested bytes; rejected `?path=`
  traversal (`..`, absolute, dotfile, symlink out of the share); the password gate on nested
  paths, including the cookie grant.
- **G3** `pnpm lint` — clean.
- **G4** Manual — create a folder share on a real workspace, open `/s/<token>`, browse into a
  subfolder, load a markdown file that embeds a relative image, and confirm the image renders.
  Confirm no response contains a path above the share root.

## Along the way

The visitor page imported `CanvasViewer` statically, so the `@excalidraw/excalidraw`
bundle was evaluated during the server render of `/s/<token>`. That package touches
`window` at module scope in its development bundle, and the production build failed
the same way, so every public share page returned 500 until this change. The viewer
now loads `CanvasViewer` through `next/dynamic` with `ssr: false`, matching the
pattern already used by `viewer-pane.tsx`.

## Open follow-ups

- Visitor navigation between markdown files relies on `href` rewriting; raw-bytes links opened in
  a new tab serve the file, not a rendered page.
- A folder share ignores the workspace-level `readOnly` flag: it is read-only by construction.
- No size budget per folder. A share of a very large tree lists one level at a time.
