# Editorial Skin Spec — "Literary Review"

A selectable skin for wiki-viewer. Refined printed-journal aesthetic (LRB / vintage
Penguin / n+1), not a loud brutalist newspaper. Calm authority for a reading-and-writing tool.

It is a NEW axis, independent of the existing light/dark theme. Composes 4 ways:
default-light, default-dark, editorial-light, editorial-dark.

## Architecture

- Existing theme axis: `next-themes`, `attribute="class"`, toggles `.dark` on `<html>`.
- New skin axis: `data-skin="editorial"` attribute on `<html>`. Absence = default skin.
- Persistence: `localStorage` key `wiki-skin`. No-flash inline script in `layout.tsx` sets
  the attribute before paint (same pattern next-themes uses).
- Selectable from settings sheet Appearance section.

CSS layering in globals.css (append AFTER existing :root and .dark blocks so it overrides):

```css
[data-skin="editorial"] {
  /* editorial light token overrides */
}
[data-skin="editorial"].dark {
  /* editorial dark token overrides */
}
```

Editorial only OVERRIDES tokens (fonts, colors, radius). Inherits everything else.

## Fonts (next/font/google, real, loadable)

In layout.tsx, load alongside existing Inter (keep Inter for default skin):

- `Fraunces` — display: headings, drop caps, document title. variable, opsz axis.
  CSS var `--font-fraunces`.
- `Newsreader` — body prose + editorial UI labels. variable. CSS var `--font-newsreader`.
- `IBM Plex Mono` — file tree, code, metadata, outline panel. weights 400,500,600.
  CSS var `--font-plex-mono`.

Expose all three variables on `<body>` className alongside `--font-inter`.

Tailwind: add fontFamily entries `display` (Fraunces), `reading` (Newsreader), `mono`
(IBM Plex Mono) referencing the vars with serif/mono fallbacks. Do NOT change the existing
`sans`/`serif` defaults (default skin must stay Inter).

Under editorial skin, body font becomes Newsreader, headings/.tiptap headings become Fraunces,
code/tree/outline become IBM Plex Mono — via the [data-skin] token block setting font on the
relevant containers (use a `--skin-font-body`, `--skin-font-display`, `--skin-font-mono`
indirection OR target containers directly in the editorial CSS block).

## Color tokens — map to EXISTING var names

### Editorial Light `[data-skin="editorial"]`

```
--background: #faf6f0;   /* warm newsprint */
--foreground: #1a1714;   /* warm ink */
--card: #fffdfa;
--card-foreground: #1a1714;
--popover: #fffdfa;
--popover-foreground: #1a1714;
--primary: #b54a1f;      /* terracotta accent (NOT vermilion — avoids destructive clash) */
--primary-foreground: #fffdfa;
--primary-soft: #f3e2d8;
--secondary: #f1ebe1;
--secondary-foreground: #1a1714;
--muted: #f1ebe1;
--muted-foreground: #756c5f;
--accent: #f1ebe1;
--accent-foreground: #b54a1f;
--accent-soft: #f3e2d8;
--destructive: #b3261e;  /* keep distinct true-red for danger */
--destructive-foreground: #fffdfa;
--destructive-soft: #f7dcda;
--success: #4a7c59;
--success-soft: #dceadf;
--warning: #b8860b;
--warning-soft: #f5ecd2;
--warning-ink: #8a6508;
--info: #1a1714;
--border: #ddd2c2;       /* parchment hairline */
--input: #ccc0ad;
--switch-checked: #b54a1f;
--ring: #b54a1f;
--overlay: rgb(26 23 20 / 0.4);
--radius: 0px;           /* square print corners */
--sidebar-background: #f4eee4;
--sidebar-foreground: #1a1714;
--sidebar-primary: #b54a1f;
--sidebar-primary-foreground: #fffdfa;
--sidebar-accent: #faf6f0;
--sidebar-accent-foreground: #b54a1f;
--sidebar-border: #ddd2c2;
--sidebar-ring: #b54a1f;
```

### Editorial Dark `[data-skin="editorial"].dark`

```
--background: #1a1714;   /* warm charcoal */
--foreground: #ece4d8;   /* warm paper-white */
--card: #221e1a;
--card-foreground: #ece4d8;
--popover: #221e1a;
--popover-foreground: #ece4d8;
--primary: #e8a07d;      /* warm terracotta, lifted for dark */
--primary-foreground: #1a1714;
--primary-soft: #3a2c22;
--secondary: #262019;
--secondary-foreground: #ece4d8;
--muted: #262019;
--muted-foreground: #a89e8e;
--accent: #2c2620;
--accent-foreground: #e8a07d;
--accent-soft: #3a2c22;
--destructive: #e5544b;
--destructive-foreground: #1a1714;
--destructive-soft: #4a211d;
--success: #7fae8c;
--success-soft: #24341f;
--warning: #d9a441;
--warning-soft: #3a2e18;
--warning-ink: #d9a441;
--info: #ece4d8;
--border: #382f26;
--input: #4a3f33;
--switch-checked: #e8a07d;
--ring: #e8a07d;
--overlay: rgb(0 0 0 / 0.6);
--sidebar-background: #161310;
--sidebar-foreground: #ece4d8;
--sidebar-primary: #e8a07d;
--sidebar-primary-foreground: #1a1714;
--sidebar-accent: #221e1a;
--sidebar-accent-foreground: #e8a07d;
--sidebar-border: #382f26;
--sidebar-ring: #e8a07d;
```

Accent appears on: links, active file in tree (left-border + text), drop cap, focus ring,
section-label underline, blockquote rule, active toolbar buttons.

## Prose redesign — `.tiptap` under `[data-skin="editorial"]`

Scope ALL of this under `[data-skin="editorial"] .tiptap` so default skin untouched.

- Container: `max-width: 66ch; margin: 0 auto;` body font Newsreader,
  `font-size: 1.0625rem; line-height: 1.65; letter-spacing: 0;`
  `text-rendering: optimizeLegibility; font-feature-settings: "liga","kern";`
- Headings: Fraunces. h1 2.25rem/600, h2 1.6rem/600, h3 1.25rem/600, h4 1.05rem/600 small-caps.
  Generous top margin (h1 0, h2 2em, h3 1.6em).
- Drop cap: `[data-skin="editorial"] .tiptap > p:first-of-type::first-letter` —
  `float:left; font-family:Fraunces; font-size:3.4em; line-height:0.72; padding:0.05em 0.12em 0 0;
color:var(--primary); font-weight:600;`
- Scotch rule under document title: handled in chrome (content header), see below.
- Blockquote: no gray fill. `border-left: 3px solid var(--primary); padding-left: 1.1rem;
font-style: italic; font-size: 1.15rem; color: var(--foreground);`
- Inline code: IBM Plex Mono, `0.85em`, `background: var(--muted); border: 1px solid var(--border);
border-radius: 0; padding: 0.05rem 0.3rem;`
- Code block (pre): IBM Plex Mono, `border-radius: 0; border-top: 1px solid var(--border);
border-bottom: 1px solid var(--border); background: var(--muted);` keep existing hljs token colors
  (they read fine on warm muted).
- Links: `color: var(--primary); text-decoration: underline; text-underline-offset: 2px;
text-decoration-thickness: 1px;`
- Lists: `ul { list-style-type: square; }` keep ol decimal.
- hr (asterism): hide the line, inject centered `✳ ✳ ✳` (Fraunces, muted, letter-spacing 0.4em)
  via `::before` on a zero-border hr; `margin: 2.5rem 0;`
- Tables: square corners, hairline borders var(--border), header row small-caps Fraunces.

## Chrome redesign — under `[data-skin="editorial"]`

All square corners (radius:0 via token). Targets are utility classes on existing markup in
src/app/page.tsx; prefer adding skin-scoped CSS in globals.css over rewriting JSX where possible.
Where a class hook is missing, add a stable className to the JSX (do not restructure layout).

- Sidebar / file tree: IBM Plex Mono for file names (`--font-plex-mono`), `font-size: 0.8125rem`.
  Active file: left border `2px solid var(--primary)`, text color var(--primary), no rounded
  background pill. Hover: subtle `var(--muted)` fill, no radius. Folder/file lucide icons may
  stay but de-emphasize (muted-foreground).
- Top toolbars (`bg-muted border-b`): make background `var(--background)` (transparent feel),
  keep single hairline bottom `1px solid var(--border)`.
- Content pane header (the `flex items-center justify-between px-4 py-2 border-b` at page.tsx
  ~1990 / ~2100): under this header add a SCOTCH RULE as the bottom border — implement via a
  skin-scoped `::after` or replace border with layered box-shadow:
  `box-shadow: 0 1px 0 0 var(--foreground), 0 3px 0 0 var(--foreground)` is wrong;
  use: bottom border 2px solid var(--foreground) + a 1px var(--foreground) hairline 2px below via
  `::after` absolute. Keep it ONLY on the active-document header, not every bar.
  Simpler acceptable version: `border-bottom: 3px double var(--foreground)` (CSS double rule).
  Use the `double` rule approach for reliability.
- Document title in header: Fraunces, slightly larger, tracking -0.01em.
- Outline panel (right): IBM Plex Mono, uppercase tracked `caption` style for the "Outline" label
  (small-caps, letter-spacing 0.12em, muted). Active outline item: var(--primary).
- Buttons: square. Primary = solid var(--primary). Ghost/secondary = transparent, hairline border
  appears on hover. Inputs: square, hairline border, focus ring var(--ring).

## Section labels (signature)

Any existing uppercase tracked `<h3>` labels (settings sections, sidebar headers): under editorial
render as small-caps Fraunces with a short terracotta underline rule. Scope via skin selector.

## Motion

Restrained. Page/content load: content fades opacity 0→1 over 400ms ease-out (no slide).
Hover: color swaps instant, background fades 120ms. No bounce. Respect existing motion tokens.

## Settings UI — Appearance section

Add a new `<section className="space-y-2">` in auth-settings-sheet.tsx (after Account, before
Signup allowlist) titled "Appearance". Contains a skin selector: two choices "Default" and
"Editorial" (segmented buttons or radio row matching existing button styling). Wire to the new
skin store. Keep the existing ThemeToggle behavior intact (theme axis is separate; it lives in
the top bar today — leave it there).

## Skin store

Create `src/stores/skin-store.ts` (zustand, matching existing store conventions). State:
`skin: "default" | "editorial"`, `setSkin(skin)`. On set: write `localStorage["wiki-skin"]`
and set/remove `document.documentElement.dataset.skin`. Initialize from the attribute the
no-flash script already set (read on mount), do NOT re-read localStorage in a way that causes
hydration mismatch.

## No-flash script (layout.tsx)

Add an inline `<script>` in `<head>` (before body) that reads `localStorage["wiki-skin"]` and,
if `=== "editorial"`, sets `document.documentElement.setAttribute("data-skin","editorial")`.
Mirror next-themes' approach. Use `suppressHydrationWarning` already present on `<html>`.

## Highest-impact, ranked

1. Fonts wired + editorial token block (the single biggest visible jump — serif prose + warm paper)
2. .tiptap prose redesign (drop cap, measure, blockquote, links)
3. File tree mono + active terracotta border
4. Scotch rule under document title + square corners
5. Outline panel + toolbars + settings selector

## Out of scope / do not touch

- Do not change default-skin appearance at all. Every editorial rule MUST be scoped under
  `[data-skin="editorial"]`.
- Do not restructure page.tsx layout/DOM hierarchy. Add classNames only where a hook is missing.
- Do not alter auth, agent API, editor logic, stores other than the new skin-store.
- Do not bump deps. next/font/google fonts need no install.
