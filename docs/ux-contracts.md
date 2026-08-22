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
- [6. Suggestions](#6-suggestions)
  - [6.1 Suggest-edit popover](#61-suggest-edit-popover)
  - [6.2 Suggestion cards](#62-suggestion-cards)
  - [6.3 Suggesting-mode capture](#63-suggesting-mode-capture)
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
(`window.__WIKI_LITE`) hides settings and skips the SSE watcher entirely (the
`/api/wiki/watch` route returns `503` in lite). `window.__WIKI_PREFIX` carries a
runtime URL prefix for reverse-proxy deployments. Mobile (≤767 px) collapses the
sidebar on mount and overlays it when reopened.

**Why it matters:** Lite mode and embed mode are the no-watch, no-settings
surfaces third parties mount; they must not assume the watcher or system config
routes exist.

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

**Contract:** Extension → viewer kind: `md/markdown`→editor; `txt`→text;
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
usable.

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
remounts the iframe. Sandbox never combines `allow-scripts` with
`allow-same-origin`.

**Why it matters:** The scripts-off default and the no-same-origin rule are the
HTML-preview security boundary; either one relaxed lets arbitrary page JS escape.

**Verification pointer:** `src/components/editor/website-viewer.tsx`,
`src/components/wiki/viewer-pane.tsx`

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

**Contract:** Opening a valid `.excalidraw` file loads its scene JSON from disk into a lazily loaded Excalidraw surface in read-only mode (`viewModeEnabled`). Fonts are served from the local `/excalidraw-assets/` path. Invalid or unreadable scene JSON shows a clear "Could not render canvas" error instead of a blank pane.

**Why it matters:** A local, read-only canvas keeps diagrams viewable offline without loading Excalidraw for unrelated files, while parse errors remain diagnosable.

**Verification pointer:** `src/components/editor/canvas-viewer.tsx`, `src/components/wiki/viewer-pane.tsx`, `src/lib/viewer-kind.ts`, `scripts/copy-excalidraw-assets.mjs`

### 3.7 History panel

**Contract:** The history panel lists commits (short SHA, message, author, time)
in a `max-h-[40vh]` scroll; clicking a commit loads a diff `<pre>` (max-h-60);
empty state "No history found.".

**Why it matters:** The panel is read-only git metadata; it must not mutate or
check out anything.

**Verification pointer:** `src/components/wiki/viewer-pane.tsx`,
`src/hooks/use-git-history.ts`

## 4. Markdown editor

### 4.1 Modes and state

**Contract:** Three modes: `viewing | editing | suggesting`. The status bar
shows an Editing/Suggesting radio (edit modes only) and a save pill
(Saving… / Saved / Save failed; hidden when idle). Suggesting mode shows the
banner "Suggesting mode · your edits become suggestions for review" and adds
`pt-7` to the scroll container; viewing mode forces non-editable and disables
task checkboxes. Autosave debounces 500 ms and is **disabled in suggesting mode**
(edits are captured as suggestions, never written directly).

**Why it matters:** The "no autosave in suggesting mode" guard is what keeps a
suggesting session from clobbering the file with un-reviewed edits.

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
undo/redo, and an RTL toggle. The bubble menu adds Comment / Suggest edit
and (read-only) only Comment. Link editing uses a popover (`Add link`/`Edit link`,
Enter applies, empty cancels, ⌘E opens a prompt for a selected link).

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

### 5.1 Comment pips and thread

**Contract:** One pip per block with ≥1 comment (instruction-kind excluded),
positioned at the block top. Pip variants: all-resolved → faded check; last turn
by `ai:` → filled primary dot; else human ring. Clicking opens a thread popover
(width `min(18rem, 100vw-1rem)`) with turn timestamps (relative time), a
`⌘↵ send` reply box, and buttons "Turn into an instruction", Resolve/Reopen.
Send uses `comment.reply` (open thread) or `comment.add`; Escalate creates an
`instruction` comment with all turns joined and a `fromCommentId` backlink.
On `409 STALE_REVISION` the sidecar reloads and retries once.

**Why it matters:** Comment ops never change file content (revision stays
fixed), so the pip/thread loop is the safe annotation path that must not bump the
file revision.

**Verification pointer:** `src/components/editor/comment-pip.tsx`,
`src/components/editor/comment-thread.tsx`

### 5.2 View-mode and source-line comments

**Contract:** In read-only mode a floating **Comment**
button appears over a non-collapsed selection; in the source viewer, comments
anchor to `lineStart:lineEnd:12-hex-SHA-256-of-selected-text`, with pips keyed by
that triple and the active thread's lines highlighted `bg-amber-400/25`.

**Why it matters:** The selection hash anchors comments to content, so they
survive line shifts; losing the hash breaks comment placement after any edit.

**Verification pointer:** `src/components/editor/view-mode-comment-button.tsx`,
`src/components/editor/source-viewer.tsx`

## 6. Suggestions

### 6.1 Suggest-edit popover

**Contract:** Opened via the bubble "Suggest edit" or the view-mode button, the
popover offers kind chips Replace block / Insert after / Insert before / Delete
block, a markdown textarea, and an optional reason. `⌘↵` submits
`suggestion.add {ref, kind, basis:"suggested", markdown?, basisDetail?}`;
`409 STALE_REVISION` retries once. Suggest is disabled when markdown is empty
(delete exempt).

**Why it matters:** Suggestions are proposed-not-applied edits; the basis and
kind are what let the reviewer see exactly what changed without touching the file.

**Verification pointer:** `src/components/editor/suggest-edit-popover.tsx`

### 6.2 Suggestion cards

**Contract:** Each pending suggestion renders a card ("`<by>` suggests replacing/
inserting after/inserting before/deleting this block") with current/proposed
panes and an optional "Reason: …". **Accept** applies via
`suggestion.accept` (retries once on 409 with the latest revision); **Reject** is
`suggestion.reject` (no retry). Both reload sidecar + snapshot on settle. Cards
are hidden in read-only mode.

**Why it matters:** Accept is the only human path that applies a suggestion;
its single-retry-then-fail on drift is the guard against clobbering concurrent
edits.

**Verification pointer:** `src/components/editor/suggestion-card.tsx`

### 6.3 Suggesting-mode capture

**Contract:** In suggesting mode, on blur / block-change / selection move, each
top-level block is diffed against the snapshot: changed → `replace`, deleted →
`delete`, appended → `insertAfter` on the last snapshot ref. The editor then
re-renders from the snapshot; nothing is written to the file.

**Why it matters:** This is the capture that turns raw typing into reviewable
suggestions; a wrong diff flushes garbage suggestions to the sidecar.

**Verification pointer:** `src/components/editor/hooks/use-suggestion-capture.ts`

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
2 s). Backlinks are rg-prefiltered (limit 400) then parse-verified (limit 50,
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
File). Text submits on **Cmd/Ctrl+Enter**; URL prepends `https://` when no
scheme; a dropped file uses the first file. Creation is `POST /api/wiki/scratch`
(JSON `{ext, content}` or multipart); the extension is detected from the first
4096 chars (HTML → md → code → txt, code shebang-first). Scratch files live in
`.scratch/`, are swept after `SCRATCH_TTL_MS` (7 days), capped at
`SCRATCH_MAX_BYTES` (50 MB). The "Save to file…" dialog (only for `.scratch/`
paths) promotes via `POST /api/wiki/move`.

**Why it matters:** Scratch is the throwaway workspace; the 7-day sweep and
50 MB cap are what keep it from filling disk, and promotion is the only path out.

**Verification pointer:** `src/components/wiki/scratchpad-create.tsx`,
`src/components/wiki/save-scratch-dialog.tsx`, `src/lib/scratch/detect.ts`,
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
failure or >`MAX_DISPLAY_SIZE` 1 MB). Password unlock (`POST`) returns 403
`wrong_password` on mismatch. A successful unlock sets an HMAC-SHA256 cookie
(`wv_share_<12-hex>`, `HttpOnly; SameSite=Strict`, `Max-Age=900`, path-scoped),
derived from the stored password hash (never the plaintext). The `/s/[token]`
page shows a password card, error states, and per-kind viewers (markdown
sanitized, source 500-line cap, HTML sandboxed with scripts off by default).

**Why it matters:** The scoped 15-min cookie and the 1 MB read cap are the share
security/robustness boundary; the password must never appear in a URL or log.

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
rotated with a confirm dialog.

**Why it matters:** The bootstrap-admin rule and the last-admin guard are the
only things preventing an accidental admin lockout.

**Verification pointer:** `src/components/auth-settings-sheet.tsx`,
`src/app/api/system/admins/route.ts`, `src/app/api/system/auth-settings/route.ts`,
`src/app/api/system/api-key/route.ts`, `src/app/api/system/users/route.ts`

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
previews).

**Why it matters:** The same-origin sandbox is a deliberate privilege grant to
the app runner, distinct from the scripts-off HTML preview; confusing the two
is a security regression.

**Verification pointer:** `src/components/editor/node-app-viewer.tsx`

### 13.2 Proxy and lifecycle

**Contract:** `ALL` verbs on `/api/app-proxy/…` resolve the longest running-app
prefix (404 `APP_NOT_FOUND` otherwise) and stream via undici, stripping upstream
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
`src/lib/app-runner.ts`

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
returns the one-shot token on approval (regId is the secret). Requests use
`Authorization: Bearer <token>` + `X-Agent-Id`; `AGENT_BEARER_TOKEN` is dead.
Only SHA-256 token hashes are stored; `enforceScope` returns `403 FORBIDDEN` on
scope/path/op mismatch, and `verifyBy` constrains the `by` actor identity.

**Why it matters:** TOFU + one-shot pickup + per-path scope is the entire agent
trust model; a leak of the registration id or a scope bypass is full file access.

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
endpoint, human instructions, the bootstrap prompt, the skill tarball
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
