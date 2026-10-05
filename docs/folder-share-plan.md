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

## Reader sidebar and reading options (v2)

A folder share should read like a docs site: persistent navigation plus controls that change the
text being read.

### Server

Every share view response gains `shareKind: "file" | "dir"`, so the client knows whether to render
navigation without guessing from the current view. `kind` keeps its meaning: what *this* response
is (a listing or a file).

### Browsing sidebar

- New `src/components/share/share-tree.tsx`, rendered only when `shareKind === "dir"`.
- Lazy: one `GET /api/share/<token>?path=<folder>` per expanded folder, cached in component state.
  Expanding a tree costs one request per folder.
- A folder row expands that folder and opens its index listing; a file row opens the file. The
  open file is marked `aria-current="page"`.
- Ancestors of the current path expand automatically, so a deep link opens with its context shown.
- Semantics are nested lists of buttons with `aria-expanded` on folder rows. Full arrow-key tree
  navigation is a follow-up.
- The collapsed state persists in `localStorage` (`wiki-share-nav`). On a narrow viewport the
  sidebar starts collapsed and opens as an overlay.
- Requests share the `share:<token>` bucket, which is keyed by token and therefore shared by every
  visitor of one link. A busy link can therefore rate-limit its own visitors. Follow-up.

### Reading options

- `ViewWidthToggle` gains an optional `showTextSize` prop, default false, so the authenticated
  toolbar is unchanged. With it, the menu also offers **Text size**, using `FONT_SCALE_STEPS` and
  `useFontStore.setScale("body", …)`.
- Width and alignment come from `view-width-store` (`VIEW_WIDTH_CLASS`, `VIEW_ALIGN_CLASS`). The
  share page passes the resulting class names into `SharedContentViewer`, which applies them to the
  markdown, source, text, and CSV wrappers in place of the hardcoded `max-w-4xl` and `max-w-6xl`.
- Body size applies to the markdown reader: its prose wrapper gets an inline
  `font-size: calc(1rem * var(--font-scale-body, 1))`. Tailwind Typography sets an absolute
  font-size on `.prose`, which a plain class of equal specificity would not reliably beat; the
  authenticated editor already consumes the same variable through `.tiptap`.
- Theme keeps the existing `ThemeToggle`.
- Text size writes the origin-wide `wiki-fonts` value, so the same person's editor body size
  changes too. That is the intended trade: one preference for one person on one origin.
- Before v2 the width control was rendered in share mode but nothing consumed it, so it did
  nothing.
- The navigation stays mounted while a view loads. Deriving its visibility from the loading
  state unmounted it on every step, which dropped its cache, refetched every ancestor folder,
  and counted each root refetch as another view.

## Acceptance gates

- **G1** `pnpm typecheck` — clean.
- **G2** `pnpm test` — pass count does not drop below `.test-floor`. New tests cover: folder
  share creation; a directory listing; nested file content; nested bytes; rejected `?path=`
  traversal (`..`, absolute, dotfile, symlink out of the share); the password gate on nested
  paths, including the cookie grant; `shareKind` on a folder share and on a file share.
- **G3** `pnpm lint` — clean.
- **G4** Manual — create a folder share on a real workspace, open `/s/<token>`, browse into a
  subfolder, load a markdown file that embeds a relative image, and confirm the image renders.
  Confirm no response contains a path above the share root. Then: expand the tree and open a file
  from it, confirm the open file is highlighted; switch width narrow to wide and confirm the text
  measure changes; raise the text size and confirm the rendered prose font size grows; reload and
  confirm the sidebar's collapsed state survives.


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
