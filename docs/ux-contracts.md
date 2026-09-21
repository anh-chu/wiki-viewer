# UX Contracts

Code is ground truth. This document is the checklist of what wiki-viewer's
user-facing surfaces **actually do today**, verified against source. It describes
observable behavior (triggers, outcomes, exact constants), not implementation
details, so it survives refactors. Undocumented behavior is invisible to
refactors and easy to break silently.

## Why this exists

A user-visible contract (a delay, a limit, a key name, a state transition) is
easy to break during unrelated work and hard to notice. Writing the contract
down turns "did we regress the loop?" into a diff against this file.

## How to use this

- **Before** changing anything user-facing, read the relevant section here.
- **After** the change, update the entry in the same change, not later.
- If code and this doc disagree, **code wins**. Fix the doc as part of the change.
- Read this file in full (or via `offset`/`limit`) before editing; never do a
  full rewrite from a possibly-truncated read. Edit by targeted replacement.
- Every behavioral entry uses one triple: **Contract** (observable
  trigger/outcome/edge cases), **Why it matters** (one sentence), and
  **Verification pointer** (file paths only — no line numbers).

## Table of Contents

- [1. Shell and workspaces](#1-shell-and-workspaces)
  - [1.1 URL state](#11-url-state)
  - [1.2 Workspace resolution](#12-workspace-resolution)
  - [1.3 AI activity and prefetch](#13-ai-activity-and-prefetch)
  - [1.4 Embed and lite mode](#14-embed-and-lite-mode)
- [2. Sidebar and file tree](#2-sidebar-and-file-tree)
  - [2.1 Create, upload, download](#21-create-upload-download)
  - [2.2 Tree keyboard navigation](#22-tree-keyboard-navigation)
  - [2.3 Viewer-kind mapping](#23-viewer-kind-mapping)
  - [2.4 Favorites, recents, and sidebar size](#24-favorites-recents-and-sidebar-size)
  - [2.5 Watching and refresh](#25-watching-and-refresh)
  - [2.6 Large-file gate](#26-large-file-gate)
- [3. Viewer pane and file viewers](#3-viewer-pane-and-file-viewers)
  - [3.1 Pane toolbar and menu](#31-pane-toolbar-and-menu)
  - [3.2 HTML / app preview](#32-html-app-preview)
  - [3.3 CSV viewer](#33-csv-viewer)
  - [3.4 PDF viewer](#34-pdf-viewer)
  - [3.5 Mermaid, notebook, source, image/media, office, fallback](#35-mermaid-notebook-source-imagemedia-office-fallback)
  - [3.6 Canvas viewer](#36-canvas-viewer)
  - [3.8 MDX viewer](#38-mdx-viewer)
  - [3.7 History panel](#37-history-panel)
- [4. Markdown editor](#4-markdown-editor)
  - [4.1 Modes and state](#41-modes-and-state)
  - [4.2 Empty / missing / loading states](#42-empty-missing-loading-states)
  - [4.3 Source mode, RTL, and paste/drop](#43-source-mode-rtl-and-pastedrop)
  - [4.4 Wiki links](#44-wiki-links)
  - [4.5 Toolbar and bubble menu](#45-toolbar-and-bubble-menu)
  - [4.6 Slash commands](#46-slash-commands)
  - [4.7 Extensions roster](#47-extensions-roster)
  - [4.8 Reading-time experiments](#48-reading-time-experiments)
- [5. Comments](#5-comments)
  - [5.1 Comment pips and thread](#51-comment-pips-and-thread)
  - [5.2 View-mode and source-line comments](#52-view-mode-and-source-line-comments)
  - [5.3 Orphaned annotations (marked lost, never destroyed)](#53-orphaned-annotations-marked-lost-never-destroyed)
- [6. Suggestions](#6-suggestions)
  - [6.1 Suggestion review and settlement](#61-suggestion-review-and-settlement)
  - [6.2 Suggestion round-trip and agent authoring](#62-suggestion-round-trip-and-agent-authoring)
  - [6.2a Suggestions and the markdown round-trip](#62a-suggestions-and-the-markdown-round-trip)
  - [6.3 Creating a suggestion](#63-creating-a-suggestion)
- [7. Search](#7-search)
  - [7.1 Command palette and sidebar search](#71-command-palette-and-sidebar-search)
  - [7.2 Snippet rendering and backend](#72-snippet-rendering-and-backend)
- [8. Uploads and assets](#8-uploads-and-assets)
  - [8.1 Upload paths and caps](#81-upload-paths-and-caps)
- [9. Scratchpad](#9-scratchpad)
  - [9.1 Create, detect, and save](#91-create-detect-and-save)
- [10. Public share links](#10-public-share-links)
  - [10.1 Create, list, revoke](#101-create-list-revoke)
  - [10.2 Read and unlock](#102-read-and-unlock)
- [11. Authentication](#11-authentication)
  - [11.1 Sign-in](#111-sign-in)
  - [11.2 Session gate and CSRF](#112-session-gate-and-csrf)
  - [11.3 Auth settings (allowlist, admins, API key)](#113-auth-settings-allowlist-admins-api-key)
- [12. Git](#12-git)
  - [12.1 Tree badges and branch switching](#121-tree-badges-and-branch-switching)
  - [12.2 History and diff](#122-history-and-diff)
- [13. App runner and node apps](#13-app-runner-and-node-apps)
  - [13.1 Node-app viewer](#131-node-app-viewer)
  - [13.2 Proxy and lifecycle](#132-proxy-and-lifecycle)
  - [13.3 Persisted-app crash supervision](#133-persisted-app-crash-supervision)
  - [13.4 Hosted apps registry and management API](#134-hosted-apps-registry-and-management-api)
  - [13.5 Hosted app slug route (`/app/<slug>`)](#135-hosted-app-slug-route-appslug)
  - [13.6 Hosted Apps sidebar section and host dialog](#136-hosted-apps-sidebar-section-and-host-dialog)
- [14. Settings and system config](#14-settings-and-system-config)
  - [14.1 Workspace management](#141-workspace-management)
  - [14.2 Config precedence](#142-config-precedence)
- [15. Agent API](#15-agent-api)
  - [15.1 Registration (TOFU) and auth](#151-registration-tofu-and-auth)
  - [15.2 Tier 1 — raw filesystem](#152-tier-1-raw-filesystem)
  - [15.3 Tier 2 — markdown collab](#153-tier-2-markdown-collab)
  - [15.4 Events, sidecar, activity, settings](#154-events-sidecar-activity-settings)
  - [15.5 Install manifest](#155-install-manifest)
  - [15.6 Agent approval and token rotation](#156-agent-approval-and-token-rotation)
- [16. MCP adapter](#16-mcp-adapter)
  - [16.1 Tool set and endpoints](#161-tool-set-and-endpoints)
- [17. CLI](#17-cli)
  - [17.1 Commands and flags](#171-commands-and-flags)
- [18. PWA](#18-pwa)
  - [18.1 Installability](#181-installability)
- [19. Theming, fonts, and persistence](#19-theming-fonts-and-persistence)
  - [19.1 Theme and view width](#191-theme-and-view-width)
  - [19.2 Fonts](#192-fonts)
  - [19.3 Persistence keys](#193-persistence-keys)
- [20. Keyboard shortcuts](#20-keyboard-shortcuts)
- [21. Non-goals / explicitly out of scope](#21-non-goals-explicitly-out-of-scope)
- [22. Known gaps](#22-known-gaps)

## 1. Shell and workspaces

### 1.1 URL state

**Contract:** The shell reads four query params: `?ws=<workspaceId>` selects the
active workspace; `?path=` opens a file; `?file=` is a legacy restore fallback;
`?url=` opens an external scratch view; `?embed=1` hides sidebar/mobile bar/
chrome unless `?chrome=1` is also present. Opening a file writes `?path=`, closing
removes it, and the browser `popstate` restores prior state. The first DirPicker
selection deletes `?path=` from the URL. Workspace switch resets the open doc.

**Why it matters:** URL state is the shareable, back/forward-safe handle for the
whole shell; breaking `?ws=`/`?path=` ordering breaks deep links and embed mode.

**Verification pointer:** `src/app/page.tsx`, `src/hooks/use-workspaces.ts`,
`src/hooks/use-open-file.ts`

### 1.2 Workspace resolution

**Contract:** An ephemeral root (`?root=`, gated by the embed API key or
`WIKI_NO_AUTH=1`) always wins and clears the workspace registry. Otherwise the
shell fetches `GET /api/system/workspaces`; the `?ws=` in the list wins, else the
most-recently-`lastOpenedAt` workspace (fallback `createdAt`); if none, the
DirPicker opens. Switching workspace best-effort `POST /.../open`, sets `?ws=`,
deletes `?path=`, clears the open doc, and invalidates slug/backlink caches.
Deleting the active workspace switches to the next-most-recent or back to the
DirPicker.

**Why it matters:** The active workspace is the single namespacing key for every
tree, viewer, search, and agent request; an ambiguous pick silently scopes
everything to the wrong root.

**Verification pointer:** `src/hooks/use-workspaces.ts`, `src/lib/workspace-context.ts`,
`src/app/api/system/workspaces/route.ts`

### 1.3 AI activity and prefetch

**Contract:** The shell polls AI activity every **10 000 ms**; `activePaths` are
files touched by events whose `by` starts with `ai:` within the last **60 s**
(green pulse dot on tree rows). On idle, the shell prefetches pinned files plus
the top 8 recents, markdown-only, deduped, capped at **12 paths**, via
`requestIdleCallback` (400 ms timeout fallback).

**Why it matters:** The 60 s window and 12-path prefetch cap are what keep a
large workspace's tree responsive without hammering the server.

**Verification pointer:** `src/app/page.tsx`, `src/stores/editor-store.ts`

### 1.4 Embed and lite mode

**Contract:** `?embed=1` (without `?chrome=1`) hides chrome; `WIKI_LITE=1`
(`window.__WIKI_LITE`) skips the SSE watcher entirely (the `/api/wiki/watch`
route returns `503` in lite). The settings panel is decoupled from lite/embed
mode: the `AuthSettingsSheet` mounts regardless of `WIKI_LITE`, so the sidebar
Settings trigger works in lite and embedded surfaces (e.g. termyard). The
sensitive sections inside it still depend on session/admin-gated `/api/system/*`
routes and degrade gracefully when those are unavailable. `window.__WIKI_PREFIX`
carries a runtime URL prefix for reverse-proxy deployments. Mobile (≤767 px)
collapses the sidebar on mount and overlays it when reopened.

**Why it matters:** Lite mode and embed mode are the no-watch surfaces third
parties mount; they must not assume the watcher exists. Settings availability is
no longer coupled to these modes; server-side auth on `/api/system/*` remains the
security boundary for the panel's admin controls.

**Verification pointer:** `src/app/layout.tsx`, `src/app/page.tsx`,
`src/lib/url-prefix.ts`, `src/app/api/wiki/watch/route.ts`

## 2. Sidebar and file tree

### 2.1 Create, upload, download

**Contract:** **New file** appends `.md` when the entered name has no `.`
(placeholder "filename (default .md)"); Enter creates, Escape cancels; success
opens the file and reloads the parent. **New folder** behaves the same with
placeholder "Folder name". **Upload** (`POST /api/wiki/upload`) accepts a
drag-drop onto a folder/root (OS file drop = copy) or a tree-node drag
(`effectAllowed:"move"`). **Download** sets `a.download` to the name (file) or
`name.zip` (directory). Copy actions expose path, wiki link (markdown only),
URL, raw content, and formatted content (text only).

**Why it matters:** The auto-`.md` suffix and the copy-vs-move drop distinction
are the two easiest behaviors to regress into silent data surprises.

**Verification pointer:** `src/components/wiki/sidebar-shell.tsx`,
`src/components/wiki/file-tree.tsx`, `src/hooks/use-upload.ts`

### 2.2 Tree keyboard navigation

**Contract:** Rows are `[role="treeitem"]` with `content-visibility:auto`. Enter/
Space opens (directory toggles; app/node-app opens+toggles); ArrowUp/Down move
focus; ArrowRight expands a collapsed dir or focuses the next row; ArrowLeft
collapses an expanded dir or focuses the nearest ancestor (paddingLeft compare).
Rows render hidden dotfiles at `opacity-40`; the active row is highlighted.

**Why it matters:** The tree is a keyboard-first surface; the ArrowLeft
collapse-or-parent behavior is the difference between usable and broken
a11y navigation.

**Verification pointer:** `src/components/wiki/file-tree.tsx`

### 2.3 Viewer-kind mapping

**Contract:** Extension → viewer kind: `md/markdown`→editor; `mdx`→mdx; `txt`→text;
`csv/tsv`→csv; `pdf`→pdf; `mmd/mermaid`→mermaid; `ipynb`→notebook;
`png/jpg/jpeg/gif/webp/svg/avif/ico/bmp`→image; `mp4/webm/mov/m4v/mp3/wav/ogg/m4a/aac`→media;
`docx`→docx; `xlsx/xlsm`→xlsx; `pptx`→pptx; `html`→html; `excalidraw`→canvas; a leading-dot file with
no further dot (`.env`, `.gitignore`) or a file with no extension → source;
listed code extensions → source; everything else → source (binary is sniffed and
falls back to download/reveal).

**Why it matters:** The kind mapping decides which viewer a file opens in; a
wrong mapping routes a file into the wrong parser or the binary fallback.

**Verification pointer:** `src/components/wiki/file-tree.tsx`,
`src/components/wiki/viewer-pane.tsx`, `src/types/wiki.ts`

### 2.4 Favorites, recents, and sidebar size

**Contract:** Favorites section is expanded by default; Recent is **collapsed by
default** and shows only the **top 8** entries (the store keeps up to 15 per
workspace, deduped newest-first). Both rows share the tree context menu. The
sidebar resize handle double-clicks to **288 px**, arrows step ±16 px, clamped to
`SIDEBAR_MIN_WIDTH` (200) / `SIDEBAR_MAX_WIDTH` (600).

**Why it matters:** The 8-vs-15 split and the 200–600 clamp are exact persisted
bounds; a regression silently over-scrolls or collapses the sidebar.

**Verification pointer:** `src/components/wiki/sidebar.tsx`,
`src/stores/sidebar-width-store.ts`, `src/stores/recent-store.ts`

### 2.5 Watching and refresh

**Contract:** The tree watches up to `WATCH_DIR_LIMIT` (24) expanded dirs via SSE
`/api/wiki/watch?dir=…` (debounced 300 ms). `rescan` reloads root + all expanded
dirs; `add`/`change`/`unlink` reload the parent and invalidate backlinks; `change`
for the open file reloads it after 400 ms. Hover prefetch settles for 120 ms then
prefetches a collapsed dir or a markdown page (one-shot cache consumed on expand).
The client scopes the SSE request to at most 24 expanded dirs. Watching is skipped
in lite mode or with no workspace.

**Why it matters:** The 24-dir cap mirrors a server limit; exceeding it degrades
to polling, and the 300/400 ms debounce is what prevents event storms from
hammering the tree.

**Verification pointer:** `src/hooks/use-file-tree.ts`,
`src/app/api/wiki/watch/route.ts`, `src/lib/search/watcher-pool.ts`

### 2.6 Large-file gate

**Contract:** Files over `LARGE_FILE_GATE_BYTES` (5 MB) open behind a
confirmation gate for unsafe viewers. `SAFE_VIEWER_KINDS` (image, media, pdf,
fallback, app, node-app, html) bypass the gate. The gate offers **Open anyway**,
**Raw**, **Download**, and **Open in Finder**; a one-shot bypass path resets on
every open.

**Why it matters:** The gate prevents a multi-GB file from freezing the editor
parser on open; the safe-kind allowlist is the only thing that keeps large media
usable. Canvas is intentionally unsafe here, so `.excalidraw` files over 5 MB
require an explicit **Open anyway** before loading the whole scene into the
editor.

**Verification pointer:** `src/components/editor/large-file-gate.tsx`,
`src/components/wiki/viewer-pane.tsx`

## 3. Viewer pane and file viewers

### 3.1 Pane toolbar and menu

**Contract:** The pane header shows the full path, a file-type icon, an optional
git author chip, and portal slots for badge + actions. The kebab menu offers
history toggle, Share, Save-to-file (scratch only), Refresh (hidden while
editing), and Width/Alignment submenus (width-aware viewers only). A pencil opens
text editing (markdown even when content is null); an eye exits markdown editing;
X closes.

**Why it matters:** The menu items are conditional on viewer kind and editing
state; showing Refresh while editing, or the pencil for a non-text file, is a
visible regression.

**Verification pointer:** `src/components/wiki/viewer-pane.tsx`

### 3.2 HTML / app preview

**Contract:** HTML previews sandbox an iframe with `allow-forms allow-popups
allow-top-navigation-by-user-activation` (no scripts by default); "Enable scripts"
adds `allow-scripts`. A "Show source"/"Show preview" toggle and an editable HTML
source textarea exist. Fullscreen mode ("App") hides the breadcrumb and offers an
"Exit app" button. The scripts toggle resets on file/external-URL change; Refresh
remounts the iframe. Toggling scripts remounts the iframe (via a
`scriptsEnabled`-keyed element) so the new sandbox takes effect without a
manual Refresh. Sandbox never combines `allow-scripts` with
`allow-same-origin`.

The preview iframe carries the workspace scope in the URL *path*
(`/api/assets/_ws/<id>/<path>`, or `/api/assets/_root/<base64url-root>/<path>`
for host-supplied ephemeral roots) rather than a `?ws=`/`?root=` query string.
This is what lets a previewed page follow its own relative links (e.g. a site's
`Journal` nav pointing at `blog.html`): the browser drops the query string on
relative navigation but preserves the path prefix, so workspace context survives
and the linked page resolves instead of 404-ing. Root-absolute links
(`/favicon.ico`) still resolve against the origin, not the asset route.

**Why it matters:** The scripts-off default and the no-same-origin rule are the
HTML-preview security boundary; either one relaxed lets arbitrary page JS escape.
The path-encoded scope keeps in-page relative navigation working without
reopening the `?root=` api-key gate (the sentinel is translated back into the
same query param `resolveWorkspaceForUser` already validates).

**Verification pointer:** `src/components/editor/website-viewer.tsx`,
`src/components/wiki/viewer-pane.tsx`,
`src/lib/workspace-client.ts` (`assetPreviewUrl`),
`src/app/api/assets/[...path]/route.ts`

### 3.3 CSV viewer

**Contract:** `GET /api/assets/{path}`. Large inputs (>2 MB or >2000 rows)
auto-switch to source mode with a "Large file (X MB, N rows)" badge; table render
chunks 1000 rows with "Show N more". Sticky header; `#` column shows row number
(hover reveals delete-row); double-click a cell/header to edit; Enter commits and
moves to the next row; Tab/Shift+Tab navigate columns; Escape/blur exits. Add row
and add column mark dirty. Save is `PUT /api/assets/{path}` (text/plain); source
toggle syncs. The badge `CSV (N rows)` = rows minus header.

**Why it matters:** The 2 MB / 2000-row threshold is what keeps large CSVs from
painting an unbounded DOM; save silently failing on error is the known sharp edge
(see Known gaps).

**Verification pointer:** `src/components/editor/csv-viewer.tsx`

### 3.4 PDF viewer

**Contract:** pdf.js renders `withWs(/api/assets/{path})` with `page-width` scale
on init. Tools: Select / Highlight / Text / Draw / Image. Any annotation
create/edit/delete sets dirty, enables **Save***, and arms a `beforeunload`
guard. Save PUTs `application/pdf` to `/api/pdf/save?path=`. Errors map
`WORKSPACE_READ_ONLY` → "Workspace is read-only". No CJK cmap/font data URL is
configured (CJK text may render blank).

**Why it matters:** The dirty→Save*→beforeunload chain is the only protection
against losing annotations; dropping it loses user edits silently.

**Verification pointer:** `src/components/editor/pdf-viewer.tsx`,
`src/app/api/pdf/save/route.ts`

### 3.5 Mermaid, notebook, source, image/media, office, fallback

**Contract:** Mermaid standalone viewer renders only after `mermaid.parse`
succeeds (`securityLevel:"loose"`, dark theme follows the `dark` class) with
Code/Diagram toggle, Copy (2 s), and SVG download; canvas pans (grab) and zooms
0.25–5 in ±0.25 steps (wheel only with ctrl/meta unless fullscreen). Notebook
shows `IPYNB` + `{N} cells · {M} code · {lang}` with per-cell In/Out numbering,
sandboxed HTML outputs (`allow-scripts`, no same-origin), and a "Hasn't been run
yet." notice. Source viewer sniffs binary (NUL or >30% control chars in first
8 KB) and disables highlighting above 2 MB / 5000 lines (chunked 2000 lines).
Image/media viewers are download + open-in-new-tab. Office viewers render docx/
pptx/xlsx (xlsx truncates at `MAX_ROWS` 2000). Unpreviewable binary shows the
"Open in Finder"/"Download" fallback.

**Why it matters:** Each viewer's size threshold (2 MB / 5000 lines / 2000 rows)
and sandbox rule is the difference between a safe render and a browser freeze or
escape.

**Verification pointer:** `src/components/editor/mermaid-viewer.tsx`,
`src/components/editor/mermaid-canvas.tsx`, `src/components/editor/notebook-viewer.tsx`,
`src/components/editor/source-viewer.tsx`, `src/components/editor/office/xlsx-viewer.tsx`,
`src/components/editor/file-fallback-viewer.tsx`

### 3.6 Canvas viewer

**Contract:** Opening a valid `.excalidraw` file loads its scene JSON from disk into a lazily loaded, editable Excalidraw surface. Changes autosave after an 800ms debounce through `PUT /api/wiki/content` with an `X-Wiki-Sha256`/`baseSha` concurrency precondition; stale saves are rejected and reload the current canvas in place. Theme, scroll, zoom, and selection state are not persisted. Pasted or dropped images are embedded in the scene JSON. Canvas files may grow to 10MB (vs 1MB for plain text edits) so embedded images fit. A new canvas is created from the sidebar "New" menu via "New canvas", which seeds the inline new-file input with `untitled.excalidraw`, creates an empty file through the existing new-file path (409 on name collision), opens it, and treats the empty/new file as a fresh blank scene whose first save writes valid scene JSON. Fonts are served from the local `/excalidraw-assets/` path. Invalid or unreadable scene JSON shows a clear "Could not render canvas" error instead of a blank pane. Read-only git workspaces and public share links load the same scene in Excalidraw view mode without autosave or write attempts; public shares allow canvas content up to 10MB. Large canvases remain behind the 5MB confirmation gate in the authenticated workbench.

**Why it matters:** An editable local canvas keeps diagrams viewable and mutable offline without loading Excalidraw for unrelated files, while sha256 guards prevent autosave from clobbering concurrent changes and parse errors remain diagnosable. View mode keeps canvases usable on read-only and public surfaces without failed save requests.

**Verification pointer:** `src/components/editor/canvas-viewer.tsx`, `src/components/wiki/viewer-pane.tsx`, `src/lib/viewer-kind.ts`, `src/app/api/wiki/content/route.ts`, `src/components/wiki/sidebar.tsx`, `src/components/wiki/sidebar-shell.tsx`, `scripts/copy-excalidraw-assets.mjs`

### 3.7 History panel

**Contract:** The history panel lists commits (short SHA, message, author, time)
in a `max-h-[40vh]` scroll; clicking a commit loads a diff `<pre>` (max-h-60);
empty state "No history found.".

**Why it matters:** The panel is read-only git metadata; it must not mutate or
check out anything.

**Verification pointer:** `src/components/wiki/viewer-pane.tsx`,
`src/hooks/use-git-history.ts`

### 3.8 MDX viewer

**Contract:** `.mdx` files open in a dedicated MDX viewer (kind `mdx`), never the
Markdown block/collab editor, because MDX embeds JSX that the clean-markdown
pipeline would mangle on round-trip. The viewer has a Source/Preview toggle and
an Enable/Disable scripts toggle; scripts are OFF by default and Preview shows a
consent prompt until the user enables them. When enabled, the source is compiled
in-browser via `@mdx-js/mdx` (`outputFormat:"program"`, `remark-gfm`,
`remark-frontmatter` stripping YAML/TOML) and executed inside a null-origin
`sandbox="allow-scripts"` iframe. React `19.2.5` (matching the app) plus
`react-dom/client` and `react/jsx-runtime` load cross-origin from `esm.sh` via an
import map; a CSP limits `connect-src`/`script-src` to `esm.sh`. Bare npm imports
inside the MDX resolve through `esm.sh` (so rendering arbitrary-import MDX
requires network); relative imports do not resolve. Compile errors render inline
as text; runtime and component render errors surface via a window error handler
and a React error boundary inside the frame. `.mdx` is treated as a
markdown-family file for the mime type (`text/markdown`), text/editable status,
sidebar icon, and wiki-link backlink scanning, but is intentionally excluded from
the tier-2 collab/block editor (`isMarkdown()` in `raw-fs`, `collab-state`,
`ops-applier` still matches only `.md`/`.markdown`). Editing `.mdx` uses the
generic plain-text source textarea and Save path, not TipTap.

**Why it matters:** MDX executes JavaScript. Running it in a null-origin
sandboxed frame with a CSP and default-off consent keeps arbitrary component code
away from the user's session, while routing `.mdx` around the block editor
prevents silent JSX corruption on save.

**Verification pointer:** `src/components/editor/mdx-viewer.tsx`,
`src/components/wiki/viewer-pane.tsx`, `src/lib/viewer-kind.ts`,
`src/lib/mime.ts`, `src/lib/search/backlinks.ts`,
`src/tests/proof/viewer-kind.test.ts`

## 4. Markdown editor

### 4.1 Modes and state

**Contract:** Two modes: `viewing | editing`. The status bar shows a save pill
(Saving… / Saved / Save failed; hidden when idle). Viewing mode forces
non-editable and disables task checkboxes; editing mode autosaves (debounced
500 ms).

Editing carries a **Suggesting** toggle. With it on, the ProseMirror transaction
that would have changed the text is rewritten to add a suggestion mark instead,
so a suggestion is created by editing normally — §6.0 and §6.3.

An earlier version of this contract stated there is "no separate suggesting
mode" and that a suggestion is created by choosing **Suggest** from the bubble
menu. That was true of the popover design, which has been removed. It is now
the opposite: suggesting IS a typing mode, and there is deliberately no
select-and-submit path.

**Why it matters:** The mark is the record. A mode that reroutes every keystroke
into a mark is safe precisely because the mark lives in the document — it
serializes, it survives reload, and accept/reject is a document transform. The
previous design's fragility came from *persisting a guess about intent* to a
sidecar per keystroke, not from the mode itself.

**Verification pointer:** `src/components/editor/editor.tsx`,
`src/stores/editor-store.ts`

### 4.2 Empty / missing / loading states

**Contract:** No path → "No page selected" + "Select a page from the sidebar or
create a new one". A missing page shows an inferred title (slug `[-_]+` → spaces,
words capitalized), "This page doesn't exist yet.", and a **Create page** button.
The loading overlay appears only after a 150 ms grace (cached/instant opens never
flash it).

**Why it matters:** The 150 ms grace is the anti-flicker contract; removing it
makes every navigation blink a spinner.

**Verification pointer:** `src/components/editor/editor.tsx`

### 4.3 Source mode, RTL, and paste/drop

**Contract:** The **Markdown/Preview** toggle (edit modes only) snapshots content
into a local textarea on enter and `updateContent` on exit. RTL is driven by
frontmatter `dir:"rtl"` (viewing: `frontmatter.data.dir`; editing: live). In edit
modes, pasting/dropping a file uploads to `POST /api/upload/{pagePath}` and
inserts an image (`image/*`) or an `<a>` link otherwise; viewing passes through.

**Why it matters:** The upload-on-paste path is the only way media enters the
editor; breaking it silently swallows pasted files.

**Verification pointer:** `src/components/editor/editor.tsx`

### 4.4 Wiki links

**Contract:** Typing `[[slug]]`, `[[slug|alias]]`, or `[[slug#anchor]]` converts
to a wiki link (`slug` regex `^[a-z0-9-]+$`). The `[[` picker filters slugs
(substring, case-insensitive, max 20 results), offers `+ Create new "query"`,
and inserts on Enter; `]` closes without insert. The create dialog offers
directory radios **entities / concepts / comparisons** (default entities),
`POST /api/wiki/page` with **409 treated as success**. Missing slugs render
`data-broken="true"` inline. Clicking a wiki link loads `{dir}/{slug}.md` (or
`{slug}.md` at root) with a 200 ms anchor scroll.

**Why it matters:** Wiki links are the navigation spine of the editor; the slug
regex, the 409-as-success rule, and the broken-link decoration are what keep
links navigable and self-healing.

**Verification pointer:** `src/components/editor/wiki-link-extension.ts`,
`src/components/editor/wiki-link-picker.tsx`, `src/components/editor/wiki-link-create-dialog.tsx`,
`src/components/editor/wiki-link-decorator.ts`, `src/components/editor/link-navigation.ts`

### 4.5 Toolbar and bubble menu

**Contract:** The toolbar offers H1/H2/H3, bold/italic/underline/strike/
inline-code/link, bullet/ordered list, blockquote, checklist, code block,
divider, align L/C/R/justify, superscript/subscript, insert image/video,
undo/redo, and an RTL toggle. The bubble menu adds Comment. Link editing uses a
popover (`Add link`/`Edit link`, Enter applies, empty cancels, ⌘E opens a prompt
for a selected link).

The block-level "Suggest edit" affordance was removed from both surfaces. It
opened a popover that proposed a whole-block replacement through the sidecar,
which is a different and weaker model than the mark-based typing path in §6.0:
that one produces a suggestion in the document, and this one produced a proposal
stored beside it. Two ways to suggest, one of them the fragile kind, was worse
than one way that works. `suggestion.add` remains part of the agent API — this
removed the HUMAN surface, not the operation.

**Why it matters:** The toolbar/bubble menus are the primary edit affordances;
the read-only bubble showing only Comment is the correct gate for view mode.

**Verification pointer:** `src/components/editor/editor-toolbar.tsx`,
`src/components/editor/bubble-menu.tsx`, `src/components/editor/link-popover.tsx`

### 4.6 Slash commands

**Contract:** `/` at line start (or after `\n`/space) opens the command menu
(filter = label OR description substring). 18 commands: Text, H1/H2/H3, Bullet/
Numbered/Checklist lists, Code block, Blockquote, Divider, Table (3×3 + header),
Image/Video/File (popovers), Callout, Warning, Math (`$x=y$`). ArrowUp/Down
navigate, Enter selects, Esc/space/backspace-empty close; a bottom preview pane
shows a live sample. The add-block gutter button dispatches a synthetic `/`
to open this menu.

**Why it matters:** The slash menu is the discoverable command surface; its
close-on-space rule and preview pane are deliberate UX that regresses easily.

**Verification pointer:** `src/components/editor/slash-commands.tsx`,
`src/components/editor/extensions/drag-handle.ts`

### 4.7 Extensions roster

**Contract:** Headings H1–H4 only; code blocks highlight 13 languages (bash, css,
go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml);
links do not open on click; images reject base64 (`allowBase64:false`) and resize
with handles clamped 80 px … container width. Heading anchors slugify text
(lowercase, strip non-word, spaces→`-`, dupes get `-1/-2…`). Callouts render
`div[data-callout=true]` with an `info` default type. Mermaid code blocks render
with a 300 ms debounce. A drag handle + add-block button appear on hover in edit
mode; `Mod-Alt-↑/↓` and `Alt-Shift-↑/↓` move the top-level block.

**Why it matters:** H1–H4, the 13-language set, the 80 px image floor, and the
no-Mod-K link rule are exact, user-visible constraints that drift breaks subtly.

**Verification pointer:** `src/components/editor/extensions.ts`,
`src/components/editor/extensions/resizable-image.tsx`,
`src/components/editor/extensions/mermaid-code-block.tsx`,
`src/components/editor/extensions/heading-anchors.ts`

### 4.8 Reading-time experiments

**Contract:** Always-on editor experiments: a read-time chip (`X min read` /
`N min left`, words ÷ 220), a breadcrumb trail (after 40 px scroll, heading
hierarchy), an anchor-flash on hash navigation, and collapsible headings
(per-path persistence). These are progressive-enhancement and must not block
editing.

**Why it matters:** The experiments are on by default but non-blocking; a
regression that breaks the read-time calculation or collapsible state is
cosmetic but user-visible.

**Verification pointer:** `src/components/editor/experiments/read-time.tsx`,
`src/components/editor/experiments/breadcrumb.tsx`,
`src/components/editor/experiments/collapsible.tsx`

## 5. Comments

### 5.1 Comment margin column and thread

**Contract:** Comments are presented the way Google Docs presents them — every
comment **persistently visible in a right-hand margin column** (`w-[19rem]`),
vertically aligned with the text it discusses. There is no gutter pip and no
floating popover for reading a thread; the card *is* the thread.

Each card is positioned at its anchor block's measured vertical offset inside the
editor scroll container. A **collision pass** then pushes any card that would
overlap the one above it down to one `CARD_GAP` (8px) below that card's measured
bottom, so comments on adjacent lines cannot stack. Cards without a measurable
anchor default to the top rather than disappearing: a comment you cannot see is
indistinguishable from a comment that was lost. The column renders only when at
least one comment exists, and cards are excluded once **cancelled** — not once
resolved. Resolved threads deliberately stay (see the resolved-thread contract
below): dropping them unmounted the card and with it the thread, so a successful
Resolve closed the thread and took the reply box with it.

At rest a card shows avatar, author, the first turn's text (clamped to 3 lines),
and a reply count; clicking expands the full thread **in place**, so opening a
comment never moves it away from its text. Expanded cards render the same body as
the legacy popover through a shared component (`variant="margin"`), so the two
presentations cannot diverge in what they offer. Hovering a card applies
`data-hovered="true"` to its exact-text highlight, tying column to document.

The column is inset `right-2` from the viewport edge and its cards span the full
column width, so the gutter never touches the window edge.

**Switching between view and edit mode remounts the editor, and the persisted state
is what carries across.** `viewer-pane.tsx` renders `<KBEditor />` and
`<KBEditor mode="viewing" />` in sibling branches of one ternary, so React unmounts one
and mounts the other on every toggle. That is the most common interaction in the app,
which makes the module-scope state load-bearing rather than a safety net. Two
consequences worth knowing:

- Suggesting mode and a Source draft survive the toggle, which is the intent.
- Source mode does **not** leak into viewing mode. An existing
  `if (isViewing) setSourceMode(false)` guard clears it, and the write-back effect
  clears the stored flag with it — but the *draft* is kept, so returning to editing
  restores the text instead of showing a raw markdown textarea over the rendered
  document. This depends on the two effects running in declaration order, so it is
  pinned by a test that models the sequence rather than assuming it.

**A reload must not unmount the editor.** `fileLoading` goes true on every external
file change, not only the first load, so `{fileLoading ? <Spinner/> : <KBEditor/>}`
replaced the editor with a spinner and unmounted it — destroying all of its component
state. Verified live: a tag set on `.ProseMirror` before such a change was gone after
it. Three separate defects came from that one line (a collapsing card, Suggesting
reverting to Editing, Source mode discarding its draft); each was fixed on its own
before the shared cause was addressed. The editor now stays mounted and the spinner is
reserved for a genuine first load, which is also when there is no editor to preserve.
The editor paints its own overlay spinner, so the outer swap was redundant as well as
destructive. Other `fileLoading ?` swaps in the viewer pane guard a toolbar icon and a
plain-text `<pre>`; neither holds state, so neither is affected.

**Source mode survives a remount, and it carries unsaved work.** Source mode is a
`<textarea>` holding the file's markdown. The remount described below reset both the
mode and its draft, so a reader typing markdown source was dropped back into the
rendered view with the draft silently discarded — no warning, and no undo, since the
store still held the older content. Both are held at module scope keyed by path, and
the draft is recorded **on every change**, not only when toggling: a write-back that
ran on toggle alone would still lose everything typed since the toggle, which is
exactly the window a remount can land in.

**The Suggesting mode path was confirmed end to end in the browser.** Toggling from the
toolbar changed the control from "Editing: your edits apply directly" to "Suggesting:
your edits are tracked until accepted". Typing in that mode produced a real `<ins>`
element carrying the insertion mark, with the Accept-all control appearing because
tracked changes existed — and the `.md` stayed byte-identical throughout (166 bytes,
revision unchanged). Accepting applied the text: 166 -> 236 bytes on save. That is the
whole of the mode: stamp on type, hold the file still while pending, write on accept.

Entering edit mode is reachable only through an icon button in the viewer toolbar,
which is why driving the mode toggle from the DOM initially found nothing: the toolbar
is gated on React state, not on the `contenteditable` attribute, so setting that
attribute cannot reach it.

That icon was originally unnamed — an icon-only `<Button>` with no `title` or
`aria-label`, so it was invisible to assistive technology and absent from any
name-based query. Since it is the *only* way into edit mode for a text file, that left
the whole editing and suggesting surface unreachable without a mouse. It is named now,
along with two icon-only close buttons in the same toolbar that had the same gap. Its
sibling "Done editing" control already had a `title`, so this was an omission rather
than a convention, and a test now fails on any unnamed icon-only button in the viewer
or the editor's comment surfaces. Confirmed in the browser: the same name-based query
that returned nothing before now returns `["Edit", "Close"]`.

**Suggesting mode is per document, like the other persisted state.** It has to outlive
the remount (losing it means edits stop being tracked without the reader being told),
but it must not be global: an earlier version used one value for the whole editor, so
turning Suggesting on for one file left the *next* file you opened also in Suggesting
mode, tracking edits the reader had not asked to track. It is keyed by path now, which
is also how Google Docs scopes it, and a path change adopts the new document's mode so
the toolbar and the stored value cannot disagree.

**Suggesting mode survives a remount too, and that one is not cosmetic.** The same
unmount that collapsed the margin card reset `suggesting` to false. A reader who had
switched to Suggesting would silently be back in Editing, and their next keystroke
would edit the document directly instead of being tracked. The mode is held at module
scope, and the plugin is **re-armed** from it whenever a new editor instance appears —
restoring the flag alone would leave the toolbar reading "Suggesting" while the
recreated plugin behaved as "editing", so the UI would claim edits were tracked when
they were not. That is worse than the reset it replaced.

**Expansion survives a remount.** Writing the sidecar counts as an external file
change, so **sending a reply remounted the editor and collapsed the thread the reader
was typing in**: the reply saved (the card gained "1 reply") while the thread vanished.
The expanded card is therefore held at module scope keyed by path, not in component
state, which is the mechanism behind the "successful ops keep the thread open" rule.

The failure is silent — everything renders and the reply saves, so only the collapse
shows. Both the failure and the fix were confirmed in the browser. Before the fix, a
reply stored (the card read "1 reply") while the thread closed. After it, the same
sequence leaves the thread open and the card expanded, with the reply persisted and
the file still byte-identical.

**A direct save must reconcile refs, or orphans are never cancelled.** `PUT
/api/wiki/content` — the editor's own save — writes the file and bumps the sidecar
revision and fingerprint, but for a long time it never recomputed `refMap`. The
cancellation logic lives in `markOrphanedRefsStale`, which only ran on the ops-applier
path, so a plain save left `refMap` describing the old document while the file on disk
was the new one. Nothing noticed, and comments whose text had been deleted went on
rendering as ordinary margin cards pointing at nothing.

Observed live on a real file: four cards in the margin, only two highlights anywhere in
the document. The sidecar made it plain — five comments, a `refMap` with a single ref,
and not one cancelled. The save route now recomputes refs from the content it just
wrote, and the same file cancelled its orphan on the next save, dropping the column from
four cards to three while leaving the resolved threads alone.

**Resolved threads outlive their text; open ones do not.** Cancellation applies only
to comments that are still open (`!c.resolved`). A thread resolved *before* its text was
deleted keeps its card — the discussion is still worth reading — but loses its
highlight, because there is no longer anything to point at. An open thread whose text
disappears is cancelled outright. Worth stating because the two look similar in the
column (a card with no highlight) while meaning different things, and the resolved case
is not a missed cancellation.

Both annotation kinds reach "gone" when their anchor is lost, by different mechanisms.
Comments need an explicit flag because they render unconditionally in the margin;
suggestions are simply filtered out everywhere (`!stale` in the editor's pending set and
in `collab-state`), so latching `stale` is enough and a cancel flag would be redundant
state.

**Typing in Suggesting mode creates a real suggestion, recorded in the document.**
Typing with the mode toggle set to Suggesting is the one human way to suggest. (It
used to share that role with the block-level suggest-edit popover, removed — see
§6.1.) A typed run carries an `insertion` mark with a `data-id`, and that mark IS the
record — it is written to the `.md` and read back on reload.

An earlier implementation recorded typed suggestions in the sidecar instead, firing a
write per keystroke. That path failed in a way worth recording: the marks were stamped,
`onTrackedEdit` was never passed to the extension, and the serialization strip removed
them on save — so the text landed as a plain permanent edit with no suggestion record.
On screen it looked pending; in the file it was already applied; a reload showed
nothing. Worse than either failure alone, because the user is told the change awaits
review while it has already taken effect.

**No keystroke-level persistence, and no coalescing window.** The old design had to
decide at every keystroke whether that character started a suggestion, continued one, or
revised one, and to persist the guess immediately — hence `COALESCE_MS = 1200` and the
`F` / `ED` / `CBA` groupings. A keystroke does not carry that intent, so the decision was
a guess made before the user finished the thought, and persisting it mutated the
document and orphaned neighbouring refs. Marks need none of this: the library assigns a
suggestion id and stamps the same id on every character of one run, so a run stays one
suggestion without a timer, and nothing has to be written until the document is saved.

**The suggestion id is minted by the library, not by the app.** `addSuggestionMarks` and
`transformToSuggestionTransaction` allocate it; the app only reads `data-id` when
counting or settling suggestions.

Writes to a document are serialized. Every op carries a base revision, so two overlapping
requests both read revision R, one wins, and the loser retries against R+1; a second
consecutive failure used to be discarded silently. One promise chain per document removes
the interleaving. A refused write is reported to the console with the server's own code,
because `postOp` previously collapsed every 409 to "not stale" and made a refused write
indistinguishable from a transport error.

**Accept all / Reject all settle the editor marks, and nothing else.** Typed
suggestions are marks with no sidecar record, so there is no second thing to settle.
The buttons also appear only when tracked marks exist, so an earlier version of this
contract was actively harmful: clicking "Accept all" because you could see two redlines
would also accept every pending agent proposal in the sidecar that you had never
opened. Agent proposals are reviewed one at a time through the §6.2 popover, which is
the only thing that settles them.

**Resolved threads keep the reply box, and the vocabulary is fixed.** Two constraints
checked against the running app rather than the source. A resolved thread expands with
its composer present (confirmed on a resolved card showing "Reopen"), because hiding the
reply box behind a resolved check would look tidy and would strand a reader who wants to
respond to a closed thread — the placeholder changes wording, not existence. And the
surfaces say "comment" and "suggestion" and nothing else: a scan of the rendered page
found no occurrence of annotation, redline, orphan, stale or pip.

**Cards host their thread in place.** Clicking a card expands the thread inside that
card at its anchor. Collapsing is the **× control** on the expanded card, not a second
click on the card: expanding unmounts the collapsed card whose button did the
expanding, so there is nothing left to click twice. The popover's Escape and
outside-click paths do not reach here either — its Escape handler is keyed on an
anchor the margin card does not have. Before the × existed, expanding a comment was a
one-way trip. The card is the thread's
home, not a launcher for a floating popover, so the comment never moves away from
the text it discusses. Focus is not stolen on expand — the click already chose the
target.

**Resolved threads stay in the column**, labelled `resolved`, rather than being
removed. Two contracts depend on this: a resolved thread always shows the reply
box, and a successful operation keeps the thread open. Dropping resolved cards
achieved neither — resolving unmounted the card, which unmounted the thread inside
it, so Resolve closed the thread and took the reply box with it. A **cancelled**
comment is still excluded, because an anchor-lost comment has nothing to point at.

For compatibility there is still a per-block pip variant: all-resolved → faded
check; last turn by `ai:` → filled primary dot; else human ring. Draft
instructions get an amber variant; routed (`queued` / `sent` / `answered`)
instructions are excluded. Pips are positioned by **block identity**, never by
DOM-child index. Thread surfaces carry turn timestamps (relative time), a
`⌘↵ send` reply box, and buttons "Turn into an instruction", Resolve/Reopen.
Send uses `comment.reply` (open thread) or `comment.add`; Escalate creates an
`instruction` comment with all turns joined and a `fromCommentId` backlink.
The thread also exposes **Edit** and **Delete** for the comment body: Edit
replaces the first turn's text (replies stay immutable; `comment.edit`, works on
resolved comments too); Delete removes the comment and its thread entirely
(`comment.delete`, confirm-gated; the pip disappears with no tombstone). On
`409 STALE_REVISION` the sidecar reloads and retries once. Every thread
affordance (reply, Edit, Delete, Escalate, Resolve/Reopen) is available in
**view mode** too — comment ops are sidecar-only and never touch the file, so
there is no read-only stripping on the thread.

**Exact-text anchors (`textAnchor`) and the exact-word highlight.** A comment may
carry `{start, end, selectedText, baseMarkdown}` naming the words it applies to.
The highlight covers **only those words** — a comment on "brown fox" marks those
two words, not the paragraph. Comments without an anchor stay block-granular
(legacy) and render no text highlight.

Positions are found by **searching the commented block's text runs** for
`selectedText`. Offset arithmetic against block markdown is explicitly NOT used to
place the highlight: those offsets describe a different string, because a list
item's markdown reads `2. Reactions in app` while its rendered node reads
`Reactions in app`. Applying them to rendered text painted the wrong characters
(observed live as `"Reactions in a"`). Text runs come from ProseMirror's own
`descendants` positions, and a match never crosses a structural gap, so text at
the end of one block cannot match text at the start of the next.

**The search is scoped to the block the comment names.** `comment.ref` identifies the
block, so the runs considered are limited to that block's position span; the block list
the decorator receives (`snapshotBlocks`) is what supplies the ordering, matching how the
editor stamps `data-block-ref` onto top-level children. Searching the whole document was a
real defect: the first match won, so with two paragraphs both containing "target" a
comment on the second paragraph highlighted the first. When a comment's block cannot be
identified the scope falls back to the whole document rather than dropping the highlight.

A highlight is labelled `comment-highlight`. A comment whose `selectedText` cannot be
found is not drawn at all: a wrong highlight is worse than none. `comment.add` rejects a
`textAnchor` whose range does not reproduce `selectedText` in the block's current markdown
(`400 INVALID_PAYLOAD`).

**Annotations hang off durable anchors, not content-derived refs.** Block refs are
`"b" + sha256(blockMarkdown).slice(0,6)`, so an annotation keyed to a ref was keyed to the
text it annotated: editing that text changed the ref and destroyed the annotation's
identity. Four mechanisms existed to guess it back — `refAliases`, `computeRefDelta`,
positional aliasing, `survivesViaAlias` — and each leaked in production, most visibly as
suggestions vanishing mid-typing.

Comments and suggestions now reference an `anchorId`. An anchor records the ref it was
last seen under, a block-local offset, and the quoted text plus 32 characters of context
either side (the W3C TextQuoteSelector shape). Resolution tries, in order: the recorded
position; the same block at a new offset; the block that took the old ref's slot; a unique
match anywhere in the document; and otherwise reports `lost`. It reports `ambiguous` when
two candidates exist and context cannot separate them, and it **never invents an offset** —
a wrong range would silently annotate other text, which is worse than a visible loss.

Anchors are resolved **server-side**, per read, against the same blocks the snapshot ships.
The editor reads its blocks and its sidecar from two independent requests, so a client-side
resolver would have nothing to resolve against; resolving once per read also guarantees the
range and the block list describe the same revision. The client uses the resolved offset
only to choose among repeated occurrences, never as arithmetic — markdown and rendered text
are different coordinate systems (a list item's markdown carries the `1. ` prefix its node
does not).

`Comment.textAnchor` is still written for one release so an older reader of a sidecar
highlights the right words, but resolution no longer consults it. A v1 sidecar is upgraded
on read: anchors for records whose ref still resolves are lifted from the recorded quote
verbatim, and a record whose ref is already gone is marked `lost` rather than given an
invented position. The upgrade is in memory and is **not** persisted by a read, so opening
a document cannot fire the watcher.

**A successful write must advance the revision the next write sends.** Every write
response carries the revision it produced, and that value is the `baseRevision` the *next*
request must send. The comment path passed it through and worked; the suggestion path
applied the response's suggestion to the store but dropped the revision. So the next
keystroke sent the revision its own previous write had already superseded, the server
refused it `409 STALE_REVISION`, the one-shot retry re-sent the same stale base, and the
typed suggestion never persisted — while the UI kept showing it as pending. `applyEvent`
reads the revision from the event it applies, and `adoptRevision` covers writes that apply
no local event; neither ever moves the base backwards, so a late reply for an older write
cannot undo a newer one.

**Editing a block keeps its annotations.** Refs are content-derived, so changing a
block's text changes its ref. `computeRefDelta` aliased only when a block's content MOVED
to another ref, so a block edited in place got no alias at all and every comment and
suggestion anchored to it was orphaned the moment the user typed — the sidecar still held
them, but their ref no longer existed in the document. Observed live as suggestions
vanishing after a keystroke. The delta now also considers position: the ref that occupied
a slot before the op is aliased to the ref occupying it after, so an edited block's
annotations follow it. Position only ever adopts a ref that is **genuinely gone** — an
insertion that merely pushes blocks down, or a reorder that moves content, aliases nothing,
because a live old ref means a different block took the slot and aliasing there would drag
an annotation onto unrelated text.

**A comment with no `textAnchor` highlights the first run of its block.** Only a comment
made from a text selection carries an anchor; the thread UI sends none for a plain block
comment (`...(textAnchor ? { textAnchor } : {})`). The decorator used to require an anchor
and skip on its absence, so a block comment showed a card in the margin and an icon beside
the paragraph while marking **nothing** in the text — the reader had a comment they could
not locate. Two comments in one document therefore rendered differently for no visible
reason. Such a comment now marks the block it names, and cannot bleed into a neighbouring
block.

The cap is **one run, not the whole block**, because a top-level block is routinely far
bigger than a paragraph: markdown gives all nine lines of a nested list to a single
`orderedList` node, so marking every run in the block painted the **entire document** for a
comment attached to one line. A whole-block comment on a long list is the normal case, not
an edge case, so the fallback marks the block's first run instead — enough to locate the
comment, with a blast radius of one run. An anchored comment is unaffected: it highlights
only its words.

The earlier `comment-highlight-recovered` label is **gone**. It compared the match
position against `textAnchor.start`, but `start` is a block-local markdown offset while a
match position is a document-global ProseMirror position — different coordinate systems,
so the comparison could never legitimately succeed and the flag carried no information
about anything. Its test had to pass an offset that did not index the phrase in order to
produce the "recovered" branch.

**Comment ops never rebuild the document.** A comment/reply/resolve/reopen
refreshes the decoration layer only — zero `markdownToHtml`, zero `setContent`.
Selection and scroll position are preserved across the whole annotation loop.

**Backspace in Suggesting mode strikes one character per press.** A suggestion is a
change the reader can accept or reject, so a deletion does not remove text: the
characters stay in place with a deletion mark, struck through.

Getting this right required changing the mechanism, not patching the symptom. The
earlier implementation cancelled the change (`filterTransaction` returned `false`) and
attached a mark. That has a consequence recorded here because it produced exactly the
symptom it looks like it should prevent: **the document does not change, so the caret
does not move, and the next press recomputes the range it has already marked.** Pressing
Backspace several times struck the same character repeatedly and the text appeared to
stop deleting after the first press. A first fix moved the caret to the start of the
range it had just marked; that treated the symptom.

The mechanism is now the vendored `prosemirror-suggest-changes`, which **rewrites** the
incoming transaction instead of cancelling it. The rewritten transaction adds the mark
and applies normally, so the document changes, the caret advances with it, and the next
press acts on the next character. There is no caret special-case left to get wrong.

Verified live, both with and without a pause between presses: on `abcdef`, six Backspace
presses across a 6-second gap produced `f`, `ef`, `def`, then continued onto the
preceding original text, with one contiguous deletion mark and the text still present
for accept/reject.

**What is correct:** deleting in Edit mode applies for real, and deleting a
multi-character selection in Suggesting mode marks the whole range in one press rather
than one character per press.

**Backspacing over text you just typed removes it** rather than striking it. Un-typing
an uncommitted insertion is not a deletion worth tracking; Google Docs behaves the same
way.

**An annotation op does not rewrite the `.md`.** The sidecar write is what records a
comment; the markdown is untouched, so the file is only written when its bytes actually
change (`contentChanged`). This was not always so, and the cost was not a wasted write:
rewriting the file bumped its mtime, chokidar reported the change, and the client
watching its own open document read that as an external edit — reloading the snapshot
and the sidecar, and in view mode reloading the page. Measured live: one
keystroke went from `3 POST + 6 GET` to `1 POST + 0 GET`, and a comment op now leaves the
`.md` mtime untouched while the sidecar still advances.

**Why it matters:** Comment ops never change file content (revision stays
fixed), so the pip/thread loop is the safe annotation path that must not bump the
file revision. Anchoring by identity is what makes three comments on three blocks
render three correctly-placed pips even when a loose list or table expands one
mdast block into several DOM nodes.

**Commenting on text always adds a NEW comment, even when the block already has one.**
The composer derives its target from the block's comments, so a thread opened *for a
selection* must override that with a null target — otherwise it adopts the block's first
existing comment, renders its Edit/Delete/Resolve row, and routes the typed text to
`comment.reply`. The failure is quiet and convincing: the composer appears, accepts text,
and reports success, while the comment the reader asked for is never created and the
selection is discarded. `textAnchor` is the signal that the reader deliberately asked to
comment on a selection, and it is what forces the new-comment path.

**Verification pointer:** `src/components/editor/comment-margin.tsx`,
`src/components/editor/extensions/comment-highlight.ts`,
`src/components/editor/comment-thread.tsx`,
`src/components/editor/comment-pip.tsx`, `src/lib/proof/pip-alignment.ts`,
`src/lib/proof/comment-decorator.ts`

**Two surfaces: the panel beside the text, and the redlines in it.**

| Surface | Shows | Reached from |
| --- | --- | --- |
| The pushed panel | Comments AND suggested changes, one card each, anchored to their block | Overlay button, top-right of the editor |
| Anchored redlines in the text | Each pending suggestion, as `ins`/`del` marks | Always visible |

**The two kinds share one panel, and that reverses an earlier split.** They were once
separate — an anchored comment column and a floating list of suggestions — on the argument
that a comment annotates a BLOCK (so aligning its card to the block's top edge is
meaningful) while a suggestion is a mark over a few words (so the same alignment tells the
reader nothing). That argument is sound about alignment and wrong about what to do with it.
The answer is to anchor a suggestion to the block its mark sits in AND quote the words the
mark covers: the card then says both "near here" and "these words", which is more than
either surface showed alone. One panel also means one collision pass, so a comment and a
suggestion on the same line cannot print on top of each other.

**The tabs live on the panel's own header**, not in a popup over it. All / Comments /
Changes sit in a row at the top of the pushed column, with the cards below. An earlier
version opened a floating box of tabs beneath the corner button while the panel positioned
itself independently; two elements computing their own place is how they end up overlapping.
A tab with nothing behind it is disabled rather than hidden, so the other two do not move
under the cursor.

**The outline is a pushing LEFT column at every width.** It uses the comments panel's model,
not a rail: a `shrink-0 flex` sibling that reserves its fixed `w-40` width out of the ROW
whenever it is open, so it cannot cover text and `margin-inline: auto` centres the document
in the space it leaves. It shows or hides as ONE state — the column's own header label
closes it, and a corner toggle at `left-2 top-10` (the annotations button's pattern, at the
opposite corner) reopens it. There is no hover expansion and no `xl`-gated overlay fallback:
expanding on hover would reflow the text on every pass over the rail, and a smaller viewport
gets the same honest reservation as the comment column. Opening or closing feeds the editor's
reflow key, because the annotation card offsets are pixel positions measured while the
reading column had a different width.

**The corner button for annotations appears only when the panel is closed, at `right-2
top-10` at every width.** While the panel shows, its hide toggle lives ON the panel header
row — the same row as the All / Comments / Changes tabs, symmetric with the outline column
whose header label closes that panel — so there is exactly one toggle per direction: panel
header hides it, corner button shows it. The button used to sit at `top-20` under the
outline's right-corner toggle; that stacking offset is gone with the outline's move to the
left column. It is a plain show/hide toggle; it holds no tabs, so it cannot disagree with
the panel about which is active.

**The panel and the text light each other up, in both directions.** Clicking a commented
phrase in the document opens its card in the panel; clicking a card highlights its words.
They share ONE piece of state (`activeMarginRef`), read by both the decoration and the
panel, so the two ends cannot show different comments as active.

`active` is deliberately NOT `hover`. Hover is transient — the pointer is over the card or
the words right now — while active is the comment being worked on, and it persists while the
reader scrolls, replies, or moves the pointer into the panel to type. With hover alone the
highlight vanished at exactly the moment it was being used, because reaching the reply box
means leaving the card.

The two are therefore styled as different KINDS, not two intensities of one:
`data-active="true"` gets a stronger tint, a heavier underline and a ring, and is drawn
without reference to hover so an active-but-not-hovered comment still reads as selected.
`[data-active][data-hovered]` has its own rule, or hovering the active comment would match
the weaker specific hover rule and appear to DE-highlight.

Clicking the text also calls `revealComments()`, which shows the panel AND selects the
Comments tab: the reader asked for a comment, so a Changes tab would hide the card they
clicked for and the click would appear to do nothing. The panel then scrolls that card into
view, because the panel does not scroll with the document and the card can easily be
off-screen.

**The repaint depends on the active ref.** The highlight plugin reads live state through
a ref, so changing the active comment dispatches no ProseMirror transaction and nothing
repaints on its own. The effect that calls `refreshCommentHighlights` listed
`hoveredMarginRef` but not `activeMarginRef`, so *hovering* a comment lit it while
*clicking* the same one did not — the two paths differed only by which of the two values had
moved. Any state the decorator reads through the ref belongs in that dependency list; a
missing entry is a silent no-op rather than an error.

The click resolves its block ref through the same per-comment `views` map the decorator used
(`view?.ref ?? comment?.ref`), not through `comment.ref` directly, so the text and the panel
always describe the same revision.

**The card offsets are pixel positions, so they are invalidated by any reflow.** This was
the hardest bug in the panel, and it was measured in a real browser rather than reasoned
about, after three confident and wrong deductions from screenshots.

The offsets are measured relative to the SCROLL CONTAINER, but the cards render in a box
that begins BELOW the panel's tab header. Those two frames therefore already disagree by
exactly the header's height, and the correct offset is `blockOffset − headerHeight`. It was
`+headerHeight`, which put every card a consistent 51px below the commented phrase — the
kind of error that reads as "the whole column is shifted" rather than as an arithmetic
mistake. Two other faults were found and fixed alongside it:

- The offsets include `scrollTop`, which is right for the comment PIPS (they live inside the
  scrolling element and must move with the text) and wrong for the panel (a sibling of that
  element, which does not move with the document). The panel now reads a second measurement,
  `viewportTop`, taken from the same rect without the scroll term.
- The collision `floor` accumulated from un-inset values while `top` added the inset, so a
  card pushed down by a collision landed a further `inset` below the card it was clearing.

**Staleness, not arithmetic, was the last one.** Opening the panel narrows the reading
column, so paragraphs rewrap taller and every block below the first moves down. The
editor box keeps its OWN size, so no resize event fires and the offsets captured at load
stayed in place — measured at 37px of error. The measurement now re-runs when the panel or
the width setting changes, and a `ResizeObserver` on the scroll container covers window
resizes and fonts landing, which bump no React state at all.

**Verification pointer:** `src/components/editor/comment-margin.tsx` (the `-headerHeight`
inset, the collision pass), `src/components/editor/editor.tsx` (the `viewportTop`
measurement, `reflowKey`, the observer), `src/components/editor/annotations-button.tsx`,
`src/stores/annotation-panel-store.ts`.

**Verification pointer:** `src/components/editor/comment-margin.tsx` (`PanelHeader`, the
`aside` root, `layout`'s inset), `src/components/editor/annotations-button.tsx`,
`src/stores/annotation-panel-store.ts` (`panelContents`).

**The margin PUSHES the document; it must not overlay it.** The column is a `shrink-0`
flex sibling with a `relative` root, not an `absolute inset-y-0` overlay.

**This reverses an earlier decision, and the reason matters.** The overlay existed for a
measured failure: as a flex sibling the column subtracts from the document area, and with
`--editor-max-w` at 60rem the remaining slack was too small for `margin-inline: auto` to
centre with, so the document silently pinned left and the Center alignment setting looked
broken while its code was untouched. Measured then: a 1253px row minus a 304px column left
949px against a 960px max-width, giving `margin-left: 0px` instead of 146.6px.

That measurement is correct, and it is also **not an argument for overlaying** — it is an
argument for reserving the width honestly. Overlaying dodges the arithmetic by letting the
document claim space the column is standing in, which is exactly how text ends up under a
card.

**The column therefore comes out of the ROW, never out of the width setting.** The column is
a `shrink-0` sibling, and the document div is `flex-1`, so the document receives
`row - column` and `margin-inline: auto` centres it within that. `--editor-max-w` keeps the
user's narrow / normal / wide value untouched.

**This distinction was got wrong once, and the width setting is what caught it.** A first
attempt subtracted the column from the variable instead:

```
--editor-max-w: min(60rem, calc(100% - 19rem))   /* WRONG */
```

That caps the document at the leftover space, so any setting larger than the cap resolves to
the same number. At a 1253px row, Normal (60rem) and Wide (90rem) BOTH produced 949px — Wide
silently became Normal and the setting looked dead. Both models avoid overlap; only the
correct one keeps the three settings meaningful.

Where two settings do collide, the viewport genuinely cannot fit the larger document beside
the column — at 1253px, a 90rem document plus a 19rem column does not fit, so Wide fills the
space it has. That is honest degradation, not a dead control: the setting differs whenever
there is room to honour it (all three are distinct from a 1920px row up).

**The width has ONE definition.** `COMMENT_COLUMN_WIDTH_CSS` is exported from
`comment-margin.tsx` and used for the column's own `width` style. The width was previously
hardcoded as `w-[19rem]`; a second copy of that number is how a layout calculation drifts
from the real width.

**Verification pointer:** `src/components/editor/comment-margin.tsx`,
`src/components/editor/extensions/comment-highlight.ts`,
`src/components/editor/comment-thread.tsx`,
`src/components/editor/comment-pip.tsx`, `src/lib/proof/pip-alignment.ts`,
`src/lib/proof/comment-decorator.ts`

**Three surfaces, split by what each can actually show.**

| Surface | Shows | Reached from |
| --- | --- | --- |
| Anchored comment column | Comments only, one card per commented block, aligned to its text | Header comment toggle |
| Anchored redline in the text | Each pending suggestion, as `ins`/`del` marks | Always visible |
| Annotations panel | **Everything**: every comment and every pending suggestion, with Approve/Reject | Header count button, top-right of the editor |

**Suggestions belong to the panel, not the column.** The column's whole mechanism is
ALIGNMENT — a card sits at its anchor's vertical offset so it reads beside the text it
discusses. That is true of a comment, which annotates a block, and false of a
suggestion, which is a mark over a few words *inside* one: a redline in paragraph 3 and
one in paragraph 40 gave two cards whose position told the reader nothing, because both
sat at their block's top edge. The panel instead lists each change with the words it
covers, which is the information the anchored position was trying and failing to convey.
The column therefore takes no suggestion props at all, so the two kinds cannot drift back
together.

**The column is toggled from the TOP BAR, not the editor.** The control lives in
`viewer-pane`'s top bar, which is shared chrome rendering in BOTH editing and viewing. It
carries a label (`Hide comments` / `Show comments`) and the comment count, and it renders
only when the open document has comments.

Three failed attempts are worth recording, because each was found by the user rather than
by a test:

1. An icon and a bare count, **disabled** when there were no comments. Disabled renders at
   40% opacity, so the control looked inert in exactly the state a reader hunts for it in.
   It is now hidden instead — off until a comment exists, so it cannot shift the toolbar
   under the cursor.
2. It sat in the **editor's own toolbar row**, which is `!isViewing`. The control therefore
   did not exist in view mode at all — the mode comments are most often read in.
3. It was then floated over the editor. It belongs in the top bar.

**Visibility state is shared, in `comment-column-store`.** The top bar owns the control and
the editor owns the document, so the store carries two fields with different writers:
`count` is published by the editor (only it can see the comments) and `collapsed` is the
reader's choice, written only by the top bar. They are separate so that a collapse survives
a document with no comments, while a document that gains one still shows its column. The
count is cleared when the editor unmounts, or the next document inherits a stale count and
the top bar offers a toggle for comments that are not there.

Jumping to a comment from the panel calls `expand` first. Without it the jump scrolls to
the text and expands a card that is not on screen, so it appears to do nothing.

**The annotation button no longer stacks under the outline.** The outline is a pushing left
column at `xl` and a left-corner toggle below it, so the right corner at `top-10` is free at
every width; the button rose from `top-20` to `top-10`. The earlier rule — two controls at
one position is not a stacking question, one of them is simply unreachable — is what moved
the controls apart for good.

**Verification pointer:** `src/components/editor/annotations-panel.tsx`,
`src/components/editor/comment-margin.tsx`, `src/components/editor/editor.tsx`

**The margin PUSHES the document; it must not overlay it.** The column is a `shrink-0`
flex sibling with a `relative` root, not an `absolute inset-y-0` overlay.

**This reverses an earlier decision, and the reason matters.** The overlay existed for a
measured failure: as a flex sibling the column subtracts from the document area, and with
`--editor-max-w` at 60rem the remaining slack was too small for `margin-inline: auto` to
centre with, so the document silently pinned left and the Center alignment setting looked
broken while its code was untouched. Measured then: a 1253px row minus a 304px column left
949px against a 960px max-width, giving `margin-left: 0px` instead of 146.6px.

That measurement is correct, and it is also **not an argument for overlaying** — it is an
argument for reserving the width honestly. Overlaying dodges the arithmetic by letting the
document claim space the column is standing in, which is exactly how text ends up under a
card. The fix is to subtract the column's width from the document's max-width while the
column is open:

```
--editor-max-w: min(60rem, calc(100% - 19rem))
```

The document is then sized against the space it actually has, and `auto` centres it within
that. Both properties hold at once: nothing is covered, and Center still centres. The
overlay could only ever have one of them.

At the same 1253px row the document now gets 949px in a 949px area — it fills its space and
centres with zero slack, which is correct behaviour rather than the old bug: a document
narrower than its available space is what gets centred, and here it is not narrower.

**The width has ONE definition.** `COMMENT_COLUMN_WIDTH_CSS` is exported from
`comment-margin.tsx` and used for both the column's own `width` style and the editor's
subtraction. The width was previously hardcoded as `w-[19rem]`; a second copy of that number
in the editor is how the subtraction drifts from the real width and centring breaks again
silently.

**Closing the column restores the full width.** The reduction is gated on
`showCommentMargin`, so hiding the column is not a permanent narrowing.

**Verification pointer:** `src/components/editor/comment-margin.tsx`
(`COMMENT_COLUMN_WIDTH_CSS`, the `aside` root), `src/components/editor/editor.tsx`
(`editorMaxWWithMargin`, `--editor-max-w`), and
`src/tests/proof/suggestion-margin-contract.test.ts` (the push-layout describe, which checks
`column + document <= row` as arithmetic across row and width combinations).

### 5.2 View-mode and source-line comments

**Contract:** In read-only markdown mode, floating **Comment** appears over a non-collapsed selection. Suggestions are authored in the editor as marks; the source viewer remains comment-only. In the source viewer, comments anchor to
`lineStart:lineEnd:12-hex-SHA-256-of-selected-text`, with pips keyed by that
triple and the active thread's lines highlighted `bg-amber-400/25`.

**One selection surface per mode.** The mode is chosen structurally by
`isViewing`, not by a flag: editing mounts `EditorBubbleMenu` (formatting, plus
Comment and Suggest); viewing mounts `ViewModeCommentButton` (Comment, plus
Suggest when a handler is wired). View mode must observe the native
`selectionchange` event itself, because TipTap's `BubbleMenu` does not fire on a
non-editable editor.

Confirmed in view mode by selecting text in the running app: both **Comment** and
**Suggest** appear, so neither capability is stripped behind read-only.

One measurement caveat worth recording, because it produced a misleading result. The two
surfaces are triggered differently: the view-mode control listens to the native
`selectionchange` event, while the edit-mode bubble menu responds to a ProseMirror
selection transaction. A raw DOM `Range` therefore opens the view-mode surface and not
the edit-mode one. Selecting text that way in edit mode returned an empty control list,
which looks like a parity failure and is not: it is the harness failing to produce the
event the edit surface listens for. The equivalence is asserted structurally in the
suite, which mounts both components and compares the capabilities they accept.

**Invariant: the two surfaces are equivalent.** Selecting text must offer the same
two capabilities in both modes. Neither may be added to one surface alone, and no
annotation affordance may be gated behind `readOnly` — a reader who cannot edit a
document still needs to comment on it. Measured live, selecting "Reactions" in each
mode:

| Mode | `contenteditable` | Affordances offered |
|---|---|---|
| View | `false` | "Add comment" |
| Edit | `true` | "Comment — discuss or annotate this selection" |

The wording differs because the components are separate; the capability set must not.
This is stated as an invariant because the failure is silent: adding `!isViewing` in
front of a shared affordance removes a capability from half the app without breaking
any test that only exercises one mode.

**Why it matters:** The selection hash anchors comments to content, so they
survive line shifts; losing the hash breaks comment placement after any edit.
For markdown blocks, storing `selectedText` (not only a hash) is what makes an
orphaned anchor *recoverable* rather than permanently lost.

**Verification pointer:** `src/components/editor/view-mode-comment-button.tsx`,
`src/components/editor/source-viewer.tsx`, `src/tests/proof/mode-affordance.test.ts`

### 5.3 Orphaned annotations (marked lost, never destroyed)

**Contract:** When a file is edited outside the block-op path, an annotation's
block ref may disappear. A comment whose anchor is gone is **marked lost**: it
gets `anchorStatus: "lost"` and stays on the record. Its card remains in the
margin, labelled as detached; it paints no highlight and contributes nothing to
`Copy-as-prompt`. It is not resolved and not cancelled, and no re-anchor
affordance is offered.

This follows Google Docs, which is the standard this feature is built to: a
comment is never silently dropped when its anchor goes away, it is kept and shown
as detached. Two earlier designs are rejected. Latching `stale = true` parked the
comment forever waiting on a re-anchor UI that was specified but never built.
Cancelling it removed something the user wrote as a side effect of somebody else's
save, which is unrecoverable and the worst option in a review tool.

The safety property the cancellation was introduced for still holds, and is now
enforced directly rather than as a side effect: `mapAnnotationsToPromptItems`
excludes a comment whose `anchorStatus` is `"lost"`, so a deleted sentence cannot
put a phantom instruction in front of an agent.

A comment whose anchor resolves to `moved` or `ambiguous` is NOT lost — the text
was found, so the annotation stays and the resolver's offsets are used. A
block-granular comment (added with no selection) annotates its paragraph as a
whole, so rewriting that paragraph's text keeps it attached; only losing its slot
orphans it.

- The previous one-way `stale` latch is gone for comments; it had no reset site
  and no surface anywhere in the UI.
- Suggestion marks are document content, not sidecar records, so they do not use a ref-based `stale` latch or agent settlement path. A raw overwrite can change the document, but any marks present remain governed by the markdown source of truth.
- A lost comment renders a card but no pip and no highlight.

**Why it matters:** An external edit used to make a comment vanish with no signal,
and the fix for that removed it *by design* — which is still losing the user's
words. Keeping the card is honest about what happened and reversible by the human,
and the prompt-exclusion rule is now written down and tested instead of being an
emergent consequence of destruction.

**Verification pointer:** `src/lib/proof/ops-applier.ts` (`markOrphanedRefsStale`),
`src/tests/proof/comment-cancellation.test.ts`,
`src/tests/proof/repro-stale-latch.test.ts`

## 6. Suggestions

### 6.0 Suggesting mode (Google Docs)

**Contract:** The editor has two modes, chosen from a toolbar toggle: **Editing**
and **Suggesting**. The button reads the current mode (`Editing` / `Suggesting`)
and carries `aria-pressed`; in suggesting mode it is tinted green. `Mod-Shift-s`
toggles it. Mode lives in the **ProseMirror plugin's state** (the vendored
suggest-changes plugin), not React state and not editor storage, because the
transaction rewriter reads it synchronously — React state would report the
previous value inside a transaction that fires in the same tick as the click.
`isSuggestChangesEnabled(state)` is the read; `enableSuggestChanges` /
`disableSuggestChanges` are the writes.

In suggesting mode:

- **Typing inserts tracked text.** The characters are real document content
  carrying an `insertion` mark, so the caret, selection, undo, IME and paste all
  behave normally. Insertions render green and underlined.
- **Deleting marks rather than removes.** The range gains a `deletion` mark and
  the text STAYS in the document, struck through. This is what makes reject
  possible at all: a decoration cannot hold text the document no longer contains.
- **Backspacing over text you just typed removes it** rather than striking it.
  Un-typing your own uncommitted insertion is not a deletion worth tracking, and
  this matches Google Docs.
- **Formatting changes are NOT tracked.** The `modification` mark exists (the
  library defines it, and it is registered) but nothing in the app applies it:
  there is no formatting-suggestion feature. Stated plainly because an earlier
  draft of this section claimed formatting changes "are tracked", which was not
  true.
- **Block-boundary edits are not tracked.** The library also expresses a
  whole-block suggestion by allowing these marks on the `doc` node. Tiptap owns
  `doc` and does not accept block marks, so inserting a list item or splitting a
  paragraph applies directly. Inline and paragraph-level edits — typing, deleting,
  formatting — are fully covered. See the note in
  `src/components/editor/extensions/suggest-changes.ts`.

Tracked marks are applied by **rewriting the incoming transaction**, not by
cancelling it and not by appending a second one. Cancelling (`filterTransaction`
returning false) was the old implementation and it was the source of the
Backspace defect: the document never changed, so the caret never advanced, and
every press re-marked the same character. Appending would put the mark in its own
undo step, so one `⌘Z` after typing a sentence would remove the mark and the text
separately.

**Suggestions are written to the `.md` file.** This reverses an earlier
invariant, deliberately. The previous design kept `.md` byte-identical while
suggestions were pending, stripping the marks before markdown conversion and
holding the suggestions in a `.proof/*.json` sidecar instead. The suggestion
therefore existed only in the sidecar, and its block refs were content-derived —
so recording a suggestion changed the block content and orphaned the refs
pointing at it. Measured: 11 suggestions in the sidecar, 8 of them `stale`, with
three refs matching no block in the document. The annotation destroyed its own
anchor.

Now the marks are the record. They serialize as `<ins data-id>` / `<del
data-id>` via stub rules in `src/lib/markdown/to-markdown.ts`, so a suggestion
survives a save, a reload, and any reader — the same model as Google Docs, where
the suggestion lives in the document rather than beside it. `data-id` must also
be allowed through `src/lib/markdown/sanitize-schema.ts`; rehype-sanitize uses
camelCase hast names there, so the entry is `dataId`. Without it the attribute is
stripped on render and the mark no longer parses back.

**Byte-identity is now scoped to a no-op visit.** The old invariant protected
pending suggestions by never writing them. What survives of it is narrower and
still real: opening a document and changing nothing must not rewrite the file,
because markdown → HTML → markdown is not the identity (a list marker gains a
second space, blank lines acquire trailing whitespace, the trailing newline is
dropped). `handleUpdate` compares against the last serialization and skips the
write when they match.

**Accept / reject** are document transforms:
accept keeps inserted text, removes deleted text, and drops the marks; reject
removes inserted text, restores deleted text (it was never gone), and drops the
marks. Multi-range operations apply last-to-first, because removing one range
shifts every later position. Each decision is a single transaction, so undo
reverts the whole decision rather than half of it.

**Why it matters:** The previous redline was drawn over text that had *already*
changed, which cannot support typing directly over the document. Marks make the
suggestion part of the document, which is what allows in-place authoring — and
the strip is what keeps that authoring invisible to the file.

**Verification pointer:** `src/components/editor/extensions/suggest-changes.ts`,
`src/vendor/prosemirror-suggest-changes/` (with `VENDORED.md` recording the one edit
made to it), `src/lib/markdown/to-markdown.ts` (the `ins` / `del` rules),
`src/lib/markdown/sanitize-schema.ts` (the `dataId` allowlist entries),
`src/tests/proof/suggestion-roundtrip.test.ts`

### 6.1 Suggestion review and settlement

**Contract:** Suggestions are ProseMirror marks in the document, rendered inline as redlines: insertions use `<ins data-id="N">…</ins>` and deletions use `<del data-id="N">…</del>`. The mark is the record and the `.md` file is the source of truth. There is no sidecar suggestion record, review popover, gutter pip, or agent operation that settles a suggestion. A human reviews the inline redline in the editor and uses its Accept or Reject controls; those controls apply document transforms and drop the mark. Accept keeps inserted text and removes deleted text; Reject removes inserted text and restores deleted text. Writing a mark changes file bytes and bumps the revision.

An agent authors a reviewable inline suggestion with `suggestion.add`, providing a block `ref`, `kind: "insert" | "remove"`, and a block-local Markdown `range`. Insertions also provide the text to insert. The server splices the corresponding mark into that block's markdown. If an agent wants an immediate committed change, it uses `block.replace`, `block.insertAfter`, `block.insertBefore`, or `block.delete` directly instead.

**A range must cover plain, unmarked text.** Anything else is refused with a 4xx that says to re-read the block, because every such input produced markup that could not round-trip. The refusals and what they prevent:

| Refused | Code | What it prevented |
| --- | --- | --- |
| Range overlapping any tag, or the text a mark already covers | `RANGE_OVERLAPS_MARK` for `ins`/`del`, else `RANGE_IN_MARK` | Crossing or nesting marks. Endpoint checks alone missed ranges whose ends landed exactly on tag boundaries: `2..23` over `A <del data-id="1">word</del> Z` produced `A <ins data-id="2"><del data-id="1">word</ins></del> Z` |
| Inserted text containing `<` or `>` | `INVALID_TEXT` | A supplied `</ins>` closed the mark early and the second tag was dropped on reload |
| Inserted text containing a blank line | `INVALID_TEXT` | The blank line ends the block, so the mark split across two paragraphs and part of the text silently stopped being suggested |
| `kind` outside `"insert"`/`"remove"` | `UNSUPPORTED_SUGGESTION_KIND` | The legacy block-level kinds were coerced to `insert`, so `kind: "delete"` wrote an insertion proposing the opposite change |

Tag detection is a real scan, not a pattern match: it tracks quoted attribute values and treats comments and declarations as single spans. A regex could not place `<a title="a>b">` or `<!-- -->` correctly, and offsets inside those previously corrupted the block.

**Marks are mutually exclusive**, so a range inside text an existing suggestion already covers is refused rather than nested. Proposing a change to text that is already a pending suggestion means settling that suggestion first. Adding a new suggestion to *unmarked* text in the same block remains fine, including on both sides of an existing mark.

**A node attribute change (e.g. paragraph alignment) applies directly rather than becoming a suggestion.** The `modification` mark is declared for inline content, so a mark on a block node makes the document invalid. The library used to try anyway and threw `RangeError: Invalid content for node doc`, so clicking Align in Suggesting mode crashed the editor; it now applies the change without a tracking mark. Reviewable node-level formatting needs a schema change and is not provided. This is a gap, not a regression: the same action previously threw.

**Node-level modifications are not supported, and never were.** The mark schema declares `modification` for inline text only, so a mark on a paragraph or other node is rejected outright — `Invalid content for node doc: <modification(paragraph("hi"))>` — and no margin card can exist for one. Nothing in the app authors an attribute modification; the parse, serialize and sanitize plumbing for `data-mod-attr-name` is kept so such a mark written by another tool survives a round-trip rather than being silently stripped, but it is not a path this app produces. Modification cards in practice are the inline `type: "text"` marks Suggesting mode creates.

**Settlement for a `modification` mark needed four fixes in the vendored library**, which upstream 0.1.8 could not do at all: `revertSuggestion` returned before the modification pass, so Reject never dispatched; both commands dropped the suggestion id before the modification pass, so approving one card applied every modification in the computed range; `removeNodeMark` was used on text, where ProseMirror throws; and `type: "text"` threw `Unknown modification type` even though it is the type this app writes. Each is marked `LOCAL EDIT (wiki-viewer)` inline and recorded in the vendored package's `VENDORED.md`.

**Why it matters:** One durable representation prevents the document and a separate suggestion store from drifting, and lets the human review exactly the text that will be written to disk.

**Verification pointer:** `src/components/editor/extensions/suggest-changes.ts`, `src/lib/proof/ops-applier.ts`, `src/lib/markdown/to-markdown.ts`, `src/lib/markdown/sanitize-schema.ts`

<!-- Retired sidecar-popover prose removed; this heading is retained for stable anchors. -->


### 6.1a Opening a document for editing does not rewrite it

**Contract:** a visit that changes nothing must not change the file's bytes.

Markdown -> HTML -> Markdown is **not** the identity in this editor. A round-trip
turns `1. ` into `1.  ` (list markers gain a second space), gives blank lines
trailing whitespace, and drops the trailing newline. Because ProseMirror fires
`onUpdate` when the editor becomes *editable*, that reformatted text was being
saved on a plain mode switch: measured live, a 166-byte file became 231 bytes with
nothing typed.

`handleUpdate` therefore compares each serialization against the **previous one**
and returns early when they match. The baseline is seeded at load time with what the
just-loaded document serializes to, and cleared whenever a new document is stamped
into the editor.

Two traps, both hit while building this:

- Comparing the round-tripped markdown against the file's **source** markdown never
  matches, so the guard never fires. The comparison must be
  serialization-to-serialization.
- Seeding the baseline with `null` is not "no baseline yet" — it guarantees the
  first update after a load writes the file, and becoming editable fires exactly
  that first update.

A genuine edit still saves; the guard only suppresses no-ops.

**Scope of the guarantee.** This covers a visit that changes nothing. A real edit
still serializes the whole document, so untouched parts of a file can be reformatted
(`1. ` -> `1.  `) as a side effect of saving a genuine change. That is pre-existing
behaviour on `main`, not something this change introduces, and it is distinct from
the round-trip contract in §6.2a.
Recorded here so the no-op fix is not mistaken for a wider formatting guarantee.
**Verification pointer:** `src/components/editor/editor.tsx` (`handleUpdate`),
`src/tests/proof/noop-save-guard.test.ts`

### 6.2a Suggestions and the markdown round-trip

**Contract:** Markdown files are the source of truth, and a suggestion is **part of
the file** — it must survive a save, a reload, and any reader.

This reverses an earlier invariant that required `.md` to stay byte-identical while
suggestions were pending, stripping the marks before conversion and holding the
suggestions in a `.proof/*.json` sidecar. That is what made suggestions fragile, and
the failure is worth recording: the file never held them, so the sidecar was the only
copy, and the block refs keying it were content-derived — recording a suggestion
changed the block content and orphaned the refs pointing at it. Measured: 11
suggestions, 8 marked `stale`, three refs matching no block in the document. The
annotation destroyed its own anchor, and nothing in the file could restore it.

What is required now:

1. **Serialize the marks.** `src/lib/markdown/to-markdown.ts` has `ins` / `del` rules
   that emit the tags with their `data-id`. Without them Turndown keeps the text and
   drops the tag, silently converting every pending suggestion into an applied edit.
   Measured: `<ins data-id="7">Added text.</ins>` became plain `Added text.`
2. **Let the attribute through the sanitizer.** `src/lib/markdown/sanitize-schema.ts`
   needs `dataId` on `ins` and `del` — rehype-sanitize uses camelCase hast names.
   Without it the attribute is stripped on render, the mark stops parsing, and a
   deletion comes back as plain `<s>` strikethrough. Measured in the browser.
3. **One serialization path.** The app has exactly one: `editor.getHTML()` in
   `editor.tsx` feeding `htmlToMarkdown`. Any new save path must not reintroduce a
   strip. Agent-authored marks go through the same path: `suggestion.add` splices
   `<ins>` / `<del>` into the block markdown, and the editor re-parses the result.
4. **A control test.** `src/tests/proof/suggestion-roundtrip.test.ts` asserts the marks
   survive markdown -> HTML -> markdown byte-for-byte, `data-id` included, and
   `src/tests/proof/suggestion-mark-e2e.test.ts` asserts the same for a mark an agent
   writes to disk.

**Why it matters:** the property to protect is that a suggestion is never lost. Putting
it in the document is what makes that possible — there is no second store to drift, and
the text a suggestion refers to cannot orphan it.

**Verification pointer:** `src/lib/markdown/to-markdown.ts`,
`src/lib/markdown/sanitize-schema.ts`,
`src/tests/proof/suggestion-roundtrip.test.ts`,
`src/tests/proof/suggestion-mark-e2e.test.ts`,
`src/vendor/prosemirror-suggest-changes/`

### 6.3 Creating a suggestion

**Contract:** A human suggests by turning on **Suggesting** mode and editing. Every
insertion becomes an `<ins data-id>` mark and every deletion a `<del data-id>` mark,
in the document, and that mark IS the record. There is no popover, no submit step, and
no sidecar write — the marks serialize into the `.md` and come back on reload (§6.2a).

Agents can create suggestions through `suggestion.add`: the server writes an inline mark using the supplied block ref, kind, and block-local Markdown range. The human reviews that mark in the editor; there is no agent settlement op or sidecar suggestion record.

**Why it matters:** One model, not two. The popover produced a proposal stored *beside*
the document and the typing path produces a change *inside* it — two lifecycles, two
failure modes, and the weaker one was reachable from the UI. The typing path is also
the Google Docs model, which is the stated standard.

**Verification pointer:** `src/components/editor/extensions/suggest-changes.ts`,
`src/tests/proof/suggestion-roundtrip.test.ts`,
`src/tests/proof/mode-affordance.test.ts` (asserts no Suggest affordance on either
surface)

### 6.4 Copy as prompt

**Contract:** A floating **Copy as prompt** dock pill is fixed bottom-center with a theme-token elevated rounded surface (`bg-popover`, `border-border`, `shadow-lg`), count badge, and integrated `✎ N suggestions` review button. It is rendered in **both view and edit mode** (comments remain annotation-only; suggestion marks are document content; the save hint and save-status chip are the edit-only parts of the annotation bar). Shown only when the document has ≥1 open comment or suggestion mark; a count badge shows how many. It opens a popover listing those items and serializes
them into a prompt the user can paste into their own agent, without creating or
writing anything. Format, numbered from 1:
`Edit the file \`<path>\` (a Markdown document). Apply these changes:` then a
blank line, then per item:
`N. Comment on "<FULL BLOCK TEXT>" (lines X-Y): "<original ask>"` followed by
each reply as an indented `- <by>: <text>` line. Suggestion marks are described
from the live document marks, anchored on the mark's block as the SNAPSHOT (file)
has it. A saved mark's tag is already embedded in that anchor, so its item stays
bare — `N. Suggestion on "<BLOCK TEXT with <ins data-id>…</ins>>": apply this
suggested insertion` (deletions: `apply this suggested deletion`) — and the
prompt ends with a **Mark legend** explaining the three tag syntaxes (`<ins
data-id="N">text</ins>` = replace the tag with its text; `<del data-id="N">text</del>`
= remove the tag and its text; `<span data-type="modification" …>` = apply the
described block-attribute change). An unsaved mark (no tag in the snapshot yet)
falls back to quoting its words: `… insert this text` / `… delete this text` +
the quoted marked text. Modification marks (attribute changes) read
`… change <attrName> from <old> to <new>`. The legend appears only when at least
one mark-based suggestion is in the prompt. The quoted
anchor is the block's full canonical markdown (resolved from the snapshot,
capped at ~200 chars with `…`), never the ref id; ref-anchored comments omit
the line range when no line metadata is available, while line-anchored
comments use `line N` / `lines N-M`. Per-item ⎘ copies one item; **Copy all** copies the
whole prompt; each shows a ~1500ms copied flip. When the clipboard is
unavailable (non-secure context) a **Show text** read-only textarea is the
manual-copy fallback. Instructions that already entered the agent route
(`queued` / `sent` / `answered`) and resolved/accepted/rejected items are
excluded; **draft** instructions are collected like ordinary comments.
`esc` / outside-click closes; empty set renders no control.

**Why it matters:** It is the no-agent escape hatch — the same durable comments
and suggestions, exported as a prompt — so the collaboration data has one home
and copy-as-prompt is just another surface over it, never a separate artifact.

**Verification pointer:** `src/components/editor/copy-as-prompt.tsx`,
`src/lib/proof/prompt-serialize.ts`

## 7. Search

### 7.1 Command palette and sidebar search

**Contract:** **Cmd/Ctrl+K** toggles the command palette (placeholder "Search
files… ( > for actions )"). An empty or `>`-prefixed query enters action mode
(Toggle dark mode / AI panel / sidebar, New file, Copy current path, Change view
width). Otherwise typing searches after a **120 ms** debounce; results honor BM25 order
(`shouldFilter={false}`), show "Top results (refine query for more)" when
truncated, "No matches." when empty. Selecting opens the file and clears the
query. The sidebar search box (placeholder "Search… (⌘K)") searches immediately
on each keystroke with ArrowUp/Down wrap and Enter-to-open.

**Why it matters:** The palette's `>` action prefix and the two-debounce split
(palette debounced, sidebar immediate) are the search UX contract.

**Verification pointer:** `src/components/search/search-command-dialog.tsx`,
`src/components/search/sidebar-search-box.tsx`, `src/stores/search-store.ts`

### 7.2 Snippet rendering and backend

**Contract:** Snippets parse FTS5/rg `<mark>…</mark>` via regex (never
`dangerouslySetInnerHTML`); marks render `bg-yellow-200 dark:bg-yellow-700`. The
`/api/wiki/search` endpoint (POST `{query, limit?}`) defaults to 30 results
(hard cap 200), ranks filename matches first (score 2000) then rg content matches
deduped, and reports `truncated` / `degraded:"rg-unavailable"`. Ripgrep spawns
per query (`--max-filesize 2M`, max 8 tokens, 10 s timeout, SIGTERM→SIGKILL after
2 s) and excludes `.excalidraw` scene files from full-text matches. Backlinks are
rg-prefiltered (limit 400) then parse-verified (limit 50,
hard cap 200).

**Why it matters:** The `<mark>` regex (not innerHTML) and the 30/200/2M caps are
the performance and XSS boundary of search.

**Verification pointer:** `src/components/search/snippet-text.tsx`,
`src/app/api/wiki/search/route.ts`, `src/lib/search/rg-search.ts`,
`src/lib/search/filename-search.ts`, `src/lib/search/backlinks.ts`

## 8. Uploads and assets

### 8.1 Upload paths and caps

**Contract:** `POST /api/wiki/upload` (multipart `file` + `dir`) caps files at
**100 MB**, sanitizes the name (`[^a-zA-Z0-9._-]`→`_`, extension preserved), and
allows only an allowlisted MIME-type **or** extension set. `POST /api/upload/…`
(the editor paste/drop path) caps at **50 MB** and dedupes names with a `-N`
suffix. `GET /api/assets/…` serves files with `Cache-Control: private, max-age=60`
and denies `.proof`/`.git`. Both are workspace-scoped and session-gated.

**Why it matters:** The 100 MB vs 50 MB caps are distinct per route; a "one-size"
cap regression silently rejects legit uploads or admits oversized ones.

**Verification pointer:** `src/app/api/wiki/upload/route.ts`,
`src/app/api/upload/[...path]/route.ts`, `src/app/api/assets/[...path]/route.ts`

## 9. Scratchpad

### 9.1 Create, detect, and save

**Contract:** **Cmd/Ctrl+Shift+N** opens the scratchpad surface (Text / URL /
Path / File / Canvas). Text submits on **Cmd/Ctrl+Enter**; URL prepends
`https://` when no scheme; the Path row opens a workspace file by typed
root-relative (or absolute-under-root) path — **Enter** or Open submits, and a
missing target shows a "File not found" toast while the surface stays open; a
dropped file uses the first file; **New canvas** creates an empty
`.scratch/scratch-*.excalidraw` and opens it in the canvas editor as a blank
scene (an empty file is a valid blank canvas; the first autosave writes scene
JSON; promote works through the usual "Save to file…"). Creation is
`POST /api/wiki/scratch`
(JSON `{ext, content}` or multipart); the extension is detected from the first
4096 chars (HTML → md → code → txt, code shebang-first) or passed explicitly
for canvas. Scratch files live in
`.scratch/`, are swept after `SCRATCH_TTL_MS` (7 days), capped at
`SCRATCH_MAX_BYTES` (50 MB). The "Save to file…" dialog (only for `.scratch/`
paths) promotes via `POST /api/wiki/move`.

**Why it matters:** Scratch is the throwaway workspace; the 7-day sweep and
50 MB cap are what keep it from filling disk, and promotion is the only path out.

**Verification pointer:** `src/components/wiki/scratchpad-create.tsx`,
`src/components/wiki/save-scratch-dialog.tsx`, `src/hooks/use-scratchpad.ts`,
`src/hooks/use-open-file.ts`, `src/lib/scratch/detect.ts`,
`src/lib/scratch/config.ts`, `src/app/api/wiki/scratch/route.ts`

## 10. Public share links

### 10.1 Create, list, revoke

**Contract:** `POST /api/share` (signed-in, workspace-scoped) validates path and
optional password/expiry, returning `{token, url:"/s/<token>", hasPassword,
expiresAt, createdAt}`. `GET /api/share?path=` lists non-revoked shares with view
counts and expiry. `DELETE /api/share/[token]` revokes (creator or admin). The
ShareDialog offers password protection and expiration (1–365 days, default 7).

**Why it matters:** Shares are public-read links scoped to a workspace+path;
revocation and expiry are the only lifetime controls.

**Verification pointer:** `src/app/api/share/route.ts`,
`src/app/api/share/[token]/route.ts`, `src/components/share-dialog.tsx`

### 10.2 Read and unlock

**Contract:** `GET /api/share/[token]` is public, rate-limited (1 per window),
and returns 404 / 410 (revoked or expired) / 401 (`protected`) / 500 (read
failure or >`MAX_DISPLAY_SIZE` 1 MB; `.excalidraw` allows 10 MB). Password
unlock (`POST`) returns 403 `wrong_password` on mismatch. A successful unlock
sets an HMAC-SHA256 cookie (`wv_share_<12-hex>`, `HttpOnly; SameSite=Strict`,
`Max-Age=900`, path-scoped), derived from the stored password hash (never the
plaintext). The `/s/[token]` page shows a password card, error states, and
per-kind viewers (markdown sanitized, source 500-line cap, HTML sandboxed with
scripts off by default, `.excalidraw` in read-only Excalidraw view mode).

**Why it matters:** The scoped 15-min cookie and the 1 MB read cap for ordinary
content are the share security/robustness boundary; the 10 MB canvas cap permits
shared diagrams while bounding scene parsing. The password must never appear in
a URL or log.

**Verification pointer:** `src/lib/shared-docs/access-grant.ts`,
`src/lib/shared-docs/db.ts`, `src/app/api/share/[token]/route.ts`,
`src/app/s/[token]/page.tsx`, `src/components/share/shared-content-viewer.tsx`

## 11. Authentication

### 11.1 Sign-in

**Contract:** The sign-in page (server-rendered) advertises google (when
`GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET`) and password auth (disabled only when
`AUTH_DISABLE_PASSWORD` **and** a social provider exist — lockout prevention).
Password inputs enforce `minLength=8`; `?next=` is honored only if it starts
with `/`. Sign-in 429 shows "Too many sign-in attempts. Wait a minute and try
again." Rate limits (production, per-IP): global 100/60 s, `/sign-in/email`
20/60 s, `/sign-up/email` 10/60 s. No configured method shows a static setup
warning. Success redirects via `window.location.href`.

**Why it matters:** The lockout-prevention guard and the exact 429 copy are the
sign-in UX contract; the rate limits are the brute-force boundary.

**Verification pointer:** `src/app/signin/page.tsx`, `src/app/signin/signin-form.tsx`,
`src/lib/auth/server.ts`, `src/lib/auth/allowlist.ts`

### 11.2 Session gate and CSRF

**Contract:** Middleware redirects unauthenticated `/` visits to
`/signin?next=…` (passthrough: `/signin`, `/api/`, `/s/`, `/_next`, icons).
The middleware only checks session-cookie *presence*, so a stale/expired cookie
still boots the workbench; the bootstrap fetch (`useWorkspaces` →
`/api/system/workspaces`) answers `401` and the client bounces to
`/signin?next=<current url>`, returning there after a successful sign-in.
`WIKI_LITE=1` returns 404 for `/api/system/`, `/api/agent(s)`, `/api/share`,
`/api/owner`, `/api/auth`, `/api/pdf`, `/signin`, `/s/`. `WIKI_NO_AUTH=1`
bypasses auth. All state-changing `/api/wiki/*` and `/api/system/*` routes check
the `Origin` header against `WIKI_OWNER_HOSTS`; a cross-origin request carrying a
session cookie is rejected `403 FORBIDDEN` (bearer-only requests pass).

**Why it matters:** The CSRF Origin check is the write-safety boundary for the
session UI; the lite/no-auth flags are the two alternate deployment modes.

**Verification pointer:** `src/middleware.ts`, `src/lib/auth/csrf.ts`

### 11.3 Auth settings (allowlist, admins, API key)

**Contract:** The auth-settings sheet edits the signup allowlist (emails/domains,
one-per-line or comma-separated) with an env→config migration banner; empty
allowlist warns anyone can sign up. Admins (bootstrap promotes the first user
when no `WIKI_ADMIN_EMAILS`) can promote/demote and create users (a 16-char
grouped temp password shown once); removing the last admin with no env fallback
is refused (`409 LAST_ADMIN`). The embed API key (64-char hex, chmod 600) can be
rotated with a confirm dialog. The service token (agent-registration bootstrap,
`~/.wiki-viewer/service-token`, 0600) shows in the same sheet with copy + rotate
(confirm dialog); rotating it invalidates MCP configs that hold the old token
(`WIKI_VIEWER_SERVICE_TOKEN` env or the file default).

**Why it matters:** The bootstrap-admin rule and the last-admin guard are the
only things preventing an accidental admin lockout.

**Verification pointer:** `src/components/auth-settings-sheet.tsx`,
`src/app/api/system/admins/route.ts`, `src/app/api/system/auth-settings/route.ts`,
`src/app/api/system/api-key/route.ts`, `src/app/api/system/service-token/route.ts`,
`src/app/api/system/users/route.ts`, `src/app/api/agent/register/route.ts`

## 12. Git

### 12.1 Tree badges and branch switching

**Contract:** Repo rows show a git badge (branch name + `*` when dirty). The
branch button opens a dropdown (filter input only when >8 branches) listing
branches (current checked/disabled). Checkout is `POST /api/wiki/git-checkout`;
`409` on a dirty tree shows "Repository has uncommitted changes". Pull shows
`Pulled <path> (<branch> @ <sha7>)`. Git workspaces are read-only (editing
disabled); refresh is admin-only.

**Why it matters:** The dirty-tree 409 is the data-loss guard on checkout; the
read-only workspace flag is what keeps cloned repos from being edited.

**Verification pointer:** `src/components/wiki/file-tree.tsx`,
`src/components/wiki/workspace-menu.tsx`, `src/hooks/use-file-tree.ts`,
`src/app/api/wiki/git-checkout/route.ts`, `src/lib/git.ts`

### 12.2 History and diff

**Contract:** `GET /api/wiki/git-history` lists commits (200 ms debounce);
`GET /api/wiki/git-diff?sha=` (SHA `/^[0-9a-f]{7,40}$/i`) returns the diff;
`GET /api/wiki/git-file-info` returns metadata or null silently. The system git
binary is invoked with tokens via `GIT_ASKPASS` (never in argv/config/ps), and
`git-secrets.ts` scans for leaked secrets.

**Why it matters:** The token-never-in-argv rule is the git credential security
boundary; breaking it leaks tokens to `ps`.

**Verification pointer:** `src/app/api/wiki/git-history/route.ts`,
`src/app/api/wiki/git-diff/route.ts`, `src/lib/git.ts`, `src/lib/git-secrets.ts`

## 13. App runner and node apps

### 13.1 Node-app viewer

**Contract:** The node-app viewer proxies `withWs(/api/app-proxy/{path}/)` and
polls every 800 ms while `installing`/`starting`; statuses are `stopped |
installing | starting | running | error` with a mono log panel. Its iframe
sandbox is `allow-scripts allow-same-origin …` (a trusted app, unlike HTML
previews). The viewer toolbar offers **Host this app**, opening the hosted-app
dialog in node mode so a directory can receive a short slug and selected npm
script.

**Workspace-root app:** When the workspace root directory is itself a node app
(`package.json` at the root), it has no tree entry of its own. A **root-app bar**
sits above the Hosted Apps section (only when `/api/wiki/app?path=` reports
`isNodeApp:true`), labelled with the workspace name and showing a running dot or
a play glyph. Clicking it opens the node-app viewer for the root (path `""`),
which supports the same launch/logs/host controls. A root app is proxied via the
reserved `~root` sentinel segment (`withWs(/api/app-proxy/~root/)`), since it has
no path prefix of its own; **Host this app** defaults the slug from the workspace
name.

**Why it matters:** The same-origin sandbox is a deliberate privilege grant to
the app runner, distinct from the scripts-off HTML preview; confusing the two
is a security regression.

**Verification pointer:** `src/components/editor/node-app-viewer.tsx`,
`src/components/wiki/host-app-dialog.tsx`, `src/components/wiki/root-app-bar.tsx`

### 13.2 Proxy and lifecycle

**Contract:** `ALL` verbs on `/api/app-proxy/…` resolve the longest running-app
prefix (404 `APP_NOT_FOUND` otherwise); a leading `~root` segment instead
resolves the workspace-root app (relPath `""`) and streams via undici, stripping upstream
`cookie/authorization/x-agent-id/x-workspace/origin`. HTML/CSS are re-fetched
identity-encoded and patched (`<base href>`, fetch/XHR rewrite); SPA 404s
re-fetch `/`. App lifecycle: install if `node_modules` missing (logs capped
200 lines), spawn with `--port` + `PORT`/`VITE_PORT`, readiness wait **30 s**
(400 ms probe), stop = SIGTERM then **SIGKILL after 2 s**. In authenticated mode
only admins may start/stop apps (`WIKI_ALLOW_APP_RUNNER=1` widens this).

**Why it matters:** The proxy's header-strip is what keeps wiki-viewer
credentials from leaking into the child app; the 30 s readiness and 2 s SIGKILL
are the start/stop liveness bounds.

**Verification pointer:** `src/app/api/app-proxy/[...path]/route.ts`,
`src/lib/app-proxy-core.ts`, `src/lib/app-runner.ts`

### 13.3 Persisted-app crash supervision (state logic)

**Contract:** Persisted (pinned) node apps are supervised by a pure state machine,
`reduceSupervision`. An unexpected child exit (`crash`) increments a plain crash
counter and, while the counter stays within `DEFAULT_CRASH_RESTART_CAP` (**5**),
requests an automatic restart with backoff. Exceeding the cap sets status `error`
and records a message with the crash count; further automatic crashes are inert.
A manual `restart` resets the crash counter and clears the error. Debounced source
file changes restart pinned apps while counting separately in
`fileWatchRestartCount`, never consuming the crash cap; changes while errored do
not resurrect the app. Pinning enables boot restore when the configured unattended
app-runner gate is enabled; unpinning stops future restore.

**Contract:** Hosted Apps sidebar rows sort pinned node apps first. Node rows expose
pin/unpin, start/stop, and status controls. Error and missing-source dots open a
compact popover with the last error, recent log tail, and **Restart now** (manual
restart); missing sources remain disabled until restored. The node-app viewer shows
an error label including its crash count.

**Why it matters:** The crash cap prevents broken pinned apps from looping forever,
while pinned-first status controls make unattended recovery visible and actionable.

**Verification pointer:** `src/lib/app-supervisor.ts`, `src/tests/proof/app-supervisor.test.ts`,
`src/lib/app-runner.ts`, `src/components/wiki/hosted-apps-section.tsx`,
`src/components/editor/node-app-viewer.tsx`, `src/stores/hosted-apps-store.ts`

### 13.4 Hosted apps registry and management API

**Contract:** A hosted app maps a short, user-chosen **slug** to a directory in
a workspace. The registry persists to `~/.wiki-viewer/hosted-apps.json`
(mirroring `agents.json`): a single in-memory source of truth with write-through
to disk, serialized through a file mutex. Each entry stores `slug`, `type`
(`html` | `node`), `workspaceId`, `relPath`, `createdAt`, plus node-only
`script`/`persist` (reserved for later tickets). Slugs are **globally unique**
across all workspaces for this cut.

Slug validation: format must match `^[a-z0-9][a-z0-9-]*$` (lowercase
alphanumeric plus hyphen, `SLUG_INVALID`), must not be a reserved name
(`api`, `app`, `apps`, `s`, `signin`, `_next`, `assets`, and other top-level
segments; `SLUG_RESERVED`), and must be globally unique (`SLUG_TAKEN`). A
duplicate error **names the workspace that already owns the slug**.

The session-gated `/api/wiki/hosted-apps` endpoint supports `GET` (list, global),
`POST` (create), and `DELETE` (unhost by slug). State-changing calls perform the
CSRF Origin check and the app-runner authorization gate: allowed when
`WIKI_NO_AUTH=1`, `WIKI_ALLOW_APP_RUNNER=1`, or the caller is admin; otherwise
`403 ADMIN_REQUIRED`. Unauthenticated calls are `401`; cross-origin cookie calls
are `403`. Create returns `201 {app}`; duplicate returns
`409 {error:"SLUG_TAKEN", message}`.

**Why it matters:** The registry is the durable spine every later Hosted Apps
surface builds on; global-unique slugs plus the reserved-name blocklist keep the
`/app/<slug>` namespace unambiguous and free of route collisions.

**Verification pointer:** `src/lib/hosted-apps.ts`,
`src/app/api/wiki/hosted-apps/route.ts`, `src/tests/proof/hosted-apps.test.ts`

### 13.5 Hosted app slug route (`/app/<slug>`)

**Contract:** `GET /app/<slug>/<...rest>` resolves the slug in the registry and,
for an `html` entry, serves the mapped target: it authenticates the user,
enforces access to the entry's owning workspace, then reads through the same
path-containment used by `/api/assets`. If `relPath` is a **directory** it is
served **dir-aware**, defaulting to `index.html` for the directory root and for
any sub-directory hit. If `relPath` is a **single file** (the "Host this" flow on
an HTML file), the root URL serves that file directly and sub-paths resolve as
siblings in the file's parent directory. For a `node` entry, every request
resolves the current runner port and forwards through the shared proxy core; a
stopped app returns a `503` "app is not running" page. A restart may choose a new
port without changing the slug URL or cached client state.

The `/app/<slug>` prefix is the app's **real, reloadable URL** and stays in the
address bar — the proxy never rewrites the URL to the child's root. To keep an
app working under that prefix, the proxy core rewrites root-absolute URLs in
served HTML/CSS, `fetch`/`XHR` calls, and redirect `Location` headers back under
`/app/<slug>`, injects `<base href="/app/<slug>/">`, and exposes
`window.__WIKI_APP_BASE__` for a client router to adopt as its `basename`.
Genuinely external redirects and absolute URLs are left untouched. An unknown
slug returns `404 APP_NOT_FOUND`.

**Why it matters:** This is the short, stable, shareable link that hides how deep
or which workspace the source directory lives in; reusing the assets path keeps
workspace scoping and traversal protection intact. Keeping the prefix in the URL
is what lets reloads and in-app links survive instead of collapsing to the bare
wiki-viewer root.

**Verification pointer:** `src/app/app/[slug]/[[...rest]]/route.ts`,
`src/lib/app-proxy-core.ts`, `src/tests/proof/app-proxy-redirect.test.ts`

### 13.6 Hosted Apps sidebar section and host dialog

**Contract:** A collapsible **Hosted Apps** section sits in the left sidebar,
styled like Favorites/Recent. It is **fetched on demand** — on section expand and
after create/unhost — never background-polled. Each row shows a type icon
(`html` globe / `node` terminal), the directory name, and a muted `/slug`;
clicking the row opens the slug URL in a new tab, and hovering reveals copy-URL
and unhost actions.

A **host dialog** (shadcn Dialog) collects the required slug, pre-filled with the
kebab-cased directory name and editable, with inline format/reserved/uniqueness
validation before submit (the server remains authoritative). For node directories
it fetches available npm scripts and lets the user choose one. It launches from the
website (HTML) viewer toolbar, node-app viewer toolbar, and from a "Host this app"
item in the file-tree context menu for directories. Node rows expose an on-demand
status dot and start/stop control; start and stop use the same app-runner
authorization gate as direct node-app controls.

**Why it matters:** One place lists everything hosted and turns a deep directory
into a one-click stable link; on-demand fetching avoids a persistent polling load
from the always-mounted sidebar.

**Verification pointer:** `src/components/wiki/hosted-apps-section.tsx`,
`src/components/wiki/host-app-dialog.tsx`,
`src/components/editor/node-app-viewer.tsx`, `src/stores/hosted-apps-store.ts`,
`src/app/api/wiki/hosted-apps/[slug]/route.ts`

## 14. Settings and system config

### 14.1 Workspace management

**Contract:** The DirPicker (Local / From Git / Over SSH) browses via
`GET /api/system/browse` (dirs only, `$HOME` default, shortcuts Home/Root/
Desktop/Documents/Downloads). Local select POSTs a workspace; Git clones
https-only, read-only (token dropped from memory); SSH mounts via sshfs with
agent/keyfile/password auth and an optional read-only flag. Pins favorite/
unfavorite directories (`POST /api/system/pins`). Reveal (`POST
/api/system/reveal`) opens the OS file manager (denies `.proof`/`.git`).

**Why it matters:** Workspace creation is admin-only; the https-only git rule
and the sshfs read-only flag are the data-exfiltration guardrails.

**Verification pointer:** `src/components/dir-picker.tsx`,
`src/app/api/system/workspaces/route.ts`, `src/app/api/system/browse/route.ts`,
`src/app/api/system/reveal/route.ts`, `src/lib/workspaces.ts`, `src/lib/sshfs.ts`

### 14.2 Config precedence

**Contract:** Config precedence is shell env > `config.json` `env` block >
CLI-derived defaults. User data lives in `~/.wiki-viewer/` (`config.json` chmod
0600, `auth.db`, `auth.secret` 0600, `agents.json`, `api-key`). Production
refuses to boot unless `BETTER_AUTH_URL` is `https://` (bypass
`WIKI_ALLOW_INSECURE=1`).

**Why it matters:** The precedence order decides which value wins a conflict;
the https boot guard is the deployment security floor.

**Verification pointer:** `src/lib/config.ts`, `bin/cli/config.js`

## 15. Agent API

### 15.1 Registration (TOFU) and auth

**Contract:** An agent registers anonymously (`POST /api/agent/register`, id
`/^ai:[a-z][a-z0-9-]{0,30}$/i`, scope `paths` 1–20 globs + `ops` ⊆
read/mutate/delete) → `202 {registrationId, pollUrl, status:"pending"}`,
rate-limited per-IP (10 cap, 1 token/6 s). Polling `GET /api/agent/register/:regId`
returns the one-shot token on approval (regId is the secret). Exception: a valid
`X-Service-Token` header (`~/.wiki-viewer/service-token`, 0600 — written at
startup, shown/rotated in Settings) auto-approves in the same response:
`200 {status:"approved", agentId, token}`; re-registration rotates the token
with a `warning`. Requests use
`Authorization: Bearer <token>` + `X-Agent-Id`; `AGENT_BEARER_TOKEN` is dead.
Only SHA-256 token hashes are stored; `enforceScope` returns `403 FORBIDDEN` on
scope/path/op mismatch, and `verifyBy` constrains the `by` actor identity.

**Why it matters:** TOFU + one-shot pickup + per-path scope is the entire agent
trust model; a leak of the registration id or a scope bypass is full file access.
The service token narrows the bootstrap credential: it can only mint scoped
agent accounts, never touch files, and rotates independently of the embed API key.

**Verification pointer:** `src/app/api/agent/register/route.ts`,
`src/app/api/agent/register/[regId]/route.ts`, `src/lib/proof/auth.ts`,
`src/lib/proof/registry.ts`, `src/lib/proof/glob.ts`

### 15.2 Tier 1 — raw filesystem

**Contract:** `GET/PUT/PATCH/DELETE /api/agent/fs/file/<path>` plus `fs/ls`
(limit 1000 / hard 10 000, depth 10 / hard 20), `fs/move`, `fs/search`
(grep|glob|fts, limit 200 / hard 2000, 10 s timeout). GET supports Range and
returns `ETag:"sha256:…"`. PUT requires `If-Match` on overwrite (`?force=true`
bypasses, audited); `?mkdirs=true` creates parents. PATCH is exact str-replace
`{find, replace, expectedOccurrences?}` (≤1 MB find/replace → 413; count
mismatch → 422). DELETE requires the `delete` scope + `If-Match`. A `.md` file in
`active` collab state is rejected `409 COLLAB_ACTIVE` unless the write carries a
matching `If-Collab-Match` revision or `?force=true`.

**Why it matters:** `If-Match`/`If-Collab-Match` are the whole-file concurrency
guards; the `COLLAB_ACTIVE` 409 is what routes agents to tier-2 instead of
clobbering a live doc.

**Verification pointer:** `src/app/api/agent/fs/file/[...path]/route.ts`,
`src/app/api/agent/fs/ls/[[...path]]/route.ts`, `src/app/api/agent/fs/move/route.ts`,
`src/app/api/agent/fs/search/route.ts`, `src/lib/proof/raw-fs.ts`

### 15.3 Tier 2 — markdown collab

**Contract:** `GET /api/agent/files/<path>` returns a block snapshot with headers
`X-Collab-State` (`active|tracked|untracked|not-markdown`),
`X-Collab-Revision`, `X-Collab-Snapshot`. `POST` applies ops and **requires** an
`Idempotency-Key` (400 `MISSING_IDEMPOTENCY_KEY`; same key + different payload →
409 `IDEMPOTENCY_KEY_REUSED`) plus `{baseRevision, by, ops}`. Revision mismatches
or external edits → `409 STALE_REVISION` (with fresh snapshot); unknown refs →
`409 BLOCK_NOT_FOUND`/`COMMENT_NOT_FOUND`/`SUGGESTION_NOT_FOUND`. Comment-only
ops never bump the revision; content ops do. Rate limit: token bucket per `by`
(default `AGENT_RATE_LIMIT` 60 ops/min) → `429 RATE_LIMITED`.

**Why it matters:** The idempotency-key + baseRevision pair is what makes tier-2
safe to retry and safe against concurrent edits; dropping either causes duplicate
or clobbered writes.

**Verification pointer:** `src/app/api/agent/files/[...path]/route.ts`,
`src/lib/proof/ops-applier.ts`, `src/lib/proof/idempotency.ts`,
`src/lib/proof/collab-state.ts`, `src/lib/proof/rate-limit.ts`

### 15.4 Events, sidecar, activity, settings

**Contract:** `GET /api/agent/events/<path>` (markdown only) returns `{events,
lastEventId}` (limit default 100 / max 1000, `after` cursor); `POST` acks with
`{upToId, by}`. `GET /api/agent/sidecar/<path>` returns the sidecar (reconciling
text-comment anchors for non-md). `GET /api/agent/activity?limit=&file=` walks
`.proof/**` (default 50, max 200). `GET /api/agent/settings` returns
`{rateLimit, root, registeredAgents, pendingRegistrations}`.
`settings/token/regenerate` is `410 GONE`.

**Why it matters:** The events cursor + ack protocol is the agent's notification
contract; the `after`/`lastEventId` semantics are what prevent replay and loss.

**Verification pointer:** `src/app/api/agent/events/[...path]/route.ts`,
`src/app/api/agent/sidecar/[...path]/route.ts`, `src/app/api/agent/activity/route.ts`,
`src/app/api/agent/settings/route.ts`

### 15.5 Install manifest

**Contract:** `GET /api/agents/install` (no auth) advertises name/version/
endpoint, human instructions, the bootstrap prompt (a build-time constant in
`src/lib/agents/bootstrap-prompt.ts` — always non-empty, never read from
`process.cwd()`), the skill tarball
(`/api/agents/skill.tar.gz`), the workspace header contract (`X-Workspace`,
`?ws=`, MRU default), capabilities (maxFileBytes 50 MB, collab states,
`If-Collab-Match`), and the MCP adapter (`wiki-viewer-mcp`). `/api/agents/skill`
serves the raw `SKILL.md`.

**Why it matters:** The manifest is the machine-readable onboarding contract an
agent reads before it registers; its capabilities block must match the real
route limits or agents will over-request.

**Verification pointer:** `src/app/api/agents/install/route.ts`,
`src/app/api/agents/skill/route.ts`, `src/app/api/agents/skill.tar.gz/route.ts`

### 15.6 Agent approval and token rotation

**Contract:** An agent registers (trust-on-first-use), the owner approves it in
the AI panel, and the agent picks up a one-shot bearer token. Approving a
registration whose agent id **already exists** mints a new token and invalidates
the old one. When this happens the same rotation notice ("Approving replaced the
existing token for `<id>`; the previous token is now invalid.") is shown at every
human touchpoint: the AI-panel approve toast (`toast.warning`), the approve API
response (`rotated: true`, `warning`), and the register CLI pickup output
(`⚠️ …`). Only SHA-256 token hashes are stored.

**Why it matters:** Silent rotation stranded operators with a token that 401'd
with no explanation; the notice makes the rotation explicit and consistent.

**Verification pointer:** `src/app/api/agent/admin/registrations/[regId]/approve/route.ts`,
`src/lib/proof/pending.ts`, `src/app/api/agent/register/[regId]/route.ts`,
`src/components/ai-panel/token-section.tsx`, `packages/wiki-viewer-mcp/src/register.ts`
## 16. MCP adapter

### 16.1 Tool set and endpoints

**Contract:** The `wiki-viewer-mcp` package exposes 7 filesystem tools
(`read_file` → GET fs/file with Range, `write_file` → PUT fs/file, `edit_file` →
**PATCH-first** with a read→transform→PUT fallback, `list_directory` → GET
fs/ls, `search` → POST fs/search, `move_file` → POST fs/move, `delete_file` →
DELETE fs/file) plus 6 live tools (`live_attach`, `live_poll`, `live_snapshot`,
`live_reply`, `live_submit_markdown`, `live_submit_web`). Configuration is via
`WIKI_VIEWER_URL` / `WIKI_VIEWER_TOKEN` / `WIKI_VIEWER_AGENT_ID` /
`WIKI_VIEWER_WORKSPACE`. The register subcommand supports `--scope-paths`
(default `**/*`), `--ops` (default `read,mutate`), `--workspace`, and `--timeout`
(default 300).

**Why it matters:** `edit_file` being PATCH-first (not read→PUT) is the real
write path; documenting the fallback chain matters because a PATCH-unsupported
environment silently switches strategies.

**Verification pointer:** `packages/wiki-viewer-mcp/src/tool-handlers.ts`,
`packages/wiki-viewer-mcp/src/http-client.ts`, `packages/wiki-viewer-mcp/src/cli.ts`

## 17. CLI

### 17.1 Commands and flags

**Contract:** `wiki-viewer` (bin entry) supports `init|setup`, `service
install|uninstall|status|logs|restart|run`, `config show|set|unset`, `update`,
plus hidden `--setup`/`--init` aliases. Flags include `-p/--port`,
`-H/--host`, `--https`, `--no-auth`, `--ssh-*`, `-e/--env`, `-v`, `-h`. Config
precedence is shell > `config.env` > derived; localhost HTTP auto-sets
`WIKI_ALLOW_INSECURE=1`; the port auto-advances to the next free port; systemd
uses `TimeoutStopSec=10`/`RestartSec=3` and the launchd label is
`com.wiki-viewer`. Node engines require `>=20.9.0`; installs use pnpm.

**Why it matters:** The CLI flags and the localhost-HTTP allowlist are the
operator's entry contract; a missing `-e/--env` or wrong service unit constants
break deployments.

**Verification pointer:** `bin/wiki-viewer.js`, `bin/cli/serve.js`,
`bin/cli/service.js`, `bin/cli/wizard.js`, `package.json`

## 18. PWA

### 18.1 Installability

**Contract:** The web manifest declares name "Wiki Viewer" / short "Wiki",
`display: standalone`, theme `#0c0a09`, and 192/512/maskable-512 icons; the
layout links `apiUrl("/manifest.webmanifest")`. Installability depends on the
manifest + icons being served at the runtime prefix.

**Why it matters:** The `display: standalone` + icon set is what makes "Add to
Home Screen" render as an app rather than a browser tab.

**Verification pointer:** `src/app/manifest.ts`, `src/app/layout.tsx`

## 19. Theming, fonts, and persistence

### 19.1 Theme and view width

**Contract:** Theme is `next-themes` (`attribute="class"`, `defaultTheme="system"`,
`enableSystem`). View width is `narrow | normal | wide` (42rem / 60rem / 90rem;
`max-w-2xl` / `max-w-[60rem]` / `max-w-[90rem]`) and alignment `center | left`
(`mx-auto` / `mr-auto`); the palette "Change view width" cycles narrow→normal→wide.

**Why it matters:** The width/align class mappings are the exact content-column
contract; a wrong class collapses or over-widens the reading pane.

**Verification pointer:** `src/stores/view-width-store.ts`,
`src/components/theme-provider.tsx`

### 19.2 Fonts

**Contract:** The font system exposes 27 fonts (sans, serif, mono) with
independent UI/body/heading/code roles and presets (classic, modern, literary,
legible, warm, stack). `DEFAULT_FONT_SCALE` is `1`, steps `[0.8…1.5]`, and any
scale in `0.5–2` is valid. Font scale applies as `--font-scale-*` CSS vars before
paint (no-flash script in the layout head).

**Why it matters:** The 0.5–2 clamp is what keeps extreme `localStorage` values
from breaking layout; the no-flash pre-paint script prevents a FOUC on load.

**Verification pointer:** `src/lib/fonts.ts`, `src/stores/font-store.ts`,
`src/app/layout.tsx`

### 19.3 Persistence keys

**Contract:** Client preferences persist to `localStorage` under: `wiki-fonts`,
`wiki-sidebar-width`, `wiki-view-width`, `wiki-view-align`, `wiki-show-hidden`,
`wiki-humanize-names`, `wiki-recent-files[-{ws}]` (max 15), `wiki-pinned-files
[-{ws}]`, `kb-page-cache`, `kb-edit-mode`, `kb-outline-pinned`,
`kb-backlinks-collapsed`, `wiki-collapsed:{path}`, `wiki-agent-token`, and the
`next-themes` theme key. URL params are `ws`/`path`/`file`/`url`/`embed`/
`chrome`.

**Why it matters:** These keys are the cross-reload user state; a rename or a
shape change silently wipes a user's fonts, width, recents, or pinned files.

**Verification pointer:** `src/stores/font-store.ts`,
`src/stores/sidebar-width-store.ts`, `src/stores/recent-store.ts`,
`src/stores/favorite-store.ts`, `src/components/editor/document-outline.tsx`,
`src/components/editor/backlinks-panel.tsx`

## 20. Keyboard shortcuts

**Contract:** The global + editor shortcut set is:

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+K` | Toggle command palette (search + actions) |
| `Cmd/Ctrl+Shift+N` | Open scratchpad create surface |
| `Cmd/Ctrl+Enter` | Scratch text submit; comment send; suggestion submit |
| `Cmd/Ctrl+S` | Save (editor autosave; hint text) |
| `/` | Slash command menu (at line start) |
| `Cmd/Ctrl+E` | Prompt for link URL on selection |
| `Cmd/Ctrl+Alt+↑/↓`, `Alt+Shift+↑/↓` | Move top-level block up/down |
| `Cmd/Ctrl+A` (in table) | Select current cell text |
| `[[` | Open wiki-link picker |
| `]` | Close wiki-link picker without insert |
| `Enter` | Apply link / select slash command / select picker item |
| `Esc` | Close link popover, slash menu, picker, thread, suggest popover |
| `Space` (slash open) | Close slash menu |
| `Backspace` (empty query) | Close slash menu / picker |
| `ArrowLeft/Right` (resize handle) | Sidebar width ±16 px |
| `Enter/Space` (tree rows) | Open / toggle tree node |

`Cmd/Ctrl+K` is deliberately **not** a link shortcut — the global palette owns it.

**Why it matters:** The shortcut registry is the muscle-memory contract; removing
or remapping one (especially the palette-vs-link `Mod-K` ownership) breaks
keyboard-driven users.

**Verification pointer:** `src/components/editor/extensions.ts`,
`src/app/page.tsx`, `src/components/search/search-command-dialog.tsx`,
`src/components/wiki/sidebar.tsx`

## 21. Non-goals / explicitly out of scope

Deliberate v1 absences (each is a contract; do not re-add without a decision):

- **Per-workspace access editor** in the auth settings sheet (TODO in source).
- **FTS search via MCP** — the server accepts `fts`, but the MCP `search` schema
  exposes only `grep|glob`.
- **`stale` live_reply status via MCP** — the wire protocol accepts `stale`, but
  the MCP tool schema excludes it (only `working|done|error`).

## 22. Known gaps

- **CSV save errors are silent** — `csv-viewer.tsx` logs save failures to the
  console only (`console.error`); there is no user-visible error surface.
- **MCP `list_directory` shape mismatch** — the server returns
  `{path, entries, truncated}` but the MCP client casts the response directly to
  an entry array (and expects `type:"directory"` while the server emits
  `"dir"`); the tests mock the array shape, hiding the drift.
- **`viewer-toolbar.tsx` `showBreadcrumb` prop is dead** — accepted but ignored
  (`_showBreadcrumb`); full path vs basename presentation is inconsistent
  between the pane header and the standalone toolbar.
- **`fonts.ts` header comment is stale** — it says "15 curated fonts (8 sans)",
  but the actual union is 27 fonts (14 sans, 7 serif, 6 mono).
- **PDF CJK rendering** — no `cMapUrl`/`standardFontDataUrl` is configured, so
  CJK text may render blank; deployment must copy cmaps/fonts manually.
- **`docs/agent-fs-plan.md` and `docs/agent-collab-plan.md` are partially stale**
  (they predate the shipped PATCH verb and Tier-1 create/move/delete); treat the
  source routes in §15 as authoritative over those plans.
