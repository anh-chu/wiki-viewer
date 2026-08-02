# wiki-viewer design tokens

This document describes the active CSS design tokens used by the wiki-viewer UI.
The previous third-party-branded design doc has been removed; these values come
from `src/app/globals.css`, `tailwind.config.ts`, and `src/app/layout.tsx`.

## Themes

- **Light/dark mode** is driven by `next-themes` (`attribute="class"`). The
  `.dark` class on `<html>` switches the dark token set.
- **Editorial skin** is an independent axis set via
  `document.documentElement.dataset.skin = "editorial"`. Editorial rules in
  `globals.css` override the default tokens and use their own font + color
  palette while inheriting layout and spacing.

## Fonts

`src/app/layout.tsx` loads four Google Font families as CSS variables:

| Variable | Font | Use |
|---|---|---|
| `--font-inter` | Inter | Default UI sans-serif |
| `--font-fraunces` | Fraunces (opsz axis) | Editorial skin display headings |
| `--font-newsreader` | Newsreader (opsz, italic) | Editorial skin body prose |
| `--font-plex-mono` | IBM Plex Mono (400/500/600) | Editorial skin code / file tree |

Tailwind maps `font-sans` to Inter, `font-mono` to IBM Plex Mono, and adds
`font-display` / `font-reading` for the editorial skin.

## Color tokens

Light mode (`:root`):

| Token | Value | Notes |
|---|---|---|
| `--background` | `#f5f5f5` | Page canvas |
| `--foreground` | `#0c0a09` | Primary text |
| `--card` | `#ffffff` | Cards / popovers |
| `--primary` | `#292524` | Buttons, active file, focus ring |
| `--primary-foreground` | `#ffffff` | Text on primary |
| `--secondary` | `#fafafa` | Secondary surfaces |
| `--muted` | `#f0efed` | Muted backgrounds |
| `--muted-foreground` | `#777169` | Muted text |
| `--accent` | `#e7e5e4` | Accent surface |
| `--accent-foreground` | `#0c0a09` | Text on accent |
| `--destructive` | `#dc2626` | Errors / destructive actions |
| `--border` | `#e7e5e4` | Hairlines / input borders |
| `--ring` | `#292524` | Focus ring |
| `--success` | `#16a34a` | Success |
| `--warning` | `#d97706` | Warning |
| `--info` | `#292524` | Info |

Dark mode (`.dark`) inverts to warm near-black surfaces with white foreground.
Semantic colors remain stable (`success`, `destructive`); warning brightens for
accessibility on dark.

### Editorial skin palette

Editorial light uses warm newsprint (`--background: #faf6f0`) with terracotta
`--primary: #b54a1f` and square corners (`--radius: 4px`). Editorial dark is a
warm charcoal (`#1a1714`) with lifted terracotta (`#e8a07d`). The full palette
is defined in `globals.css` under `[data-skin="editorial"]` and
`[data-skin="editorial"].dark`.

## Shape, motion, and elevation

| Token | Value |
|---|---|
| `--radius` | `8px` default; `4px` under editorial |
| `--motion-fast` | `100ms` |
| `--motion-base` | `150ms` |
| `--motion-slow` | `300ms` |
| `--motion-easing` | `cubic-bezier(0, 0, 0.2, 1)` |
| `--shadow-golden-card` | `0 4px 16px rgba(0, 0, 0, 0.04)` light / `rgba(...,0.3)` dark |
| `--shadow-golden-pop` | `0 8px 24px rgba(0, 0, 0, 0.06)` |
| `--shadow-golden-dialog` | `0 16px 48px rgba(0, 0, 0, 0.08)` |
| `--shadow-golden-toast` | `0 24px 64px rgba(0, 0, 0, 0.1)` |

Tailwind exposes elevations as `shadow-golden`, `shadow-e-1` … `shadow-e-5`.

## Z-index scale

| Token | Value |
|---|---|
| `--z-sticky` | `10` |
| `--z-sidebar` | `30` |
| `--z-overlay` | `40` |
| `--z-float` | `50` |

## Editor-specific tokens

The `.tiptap` editor uses slightly smaller body text (`0.9375rem`) with
relaxed line height (`1.7`) and negative tracking. Heading sizes, list styles,
blockquote border, table markup, task-list checkbox styling, and wiki-link /
proof-span marks are all defined in `globals.css`. Syntax highlighting uses the
product palette (keyword/accent-foreground, string/success, number/warning-ink,
comment/muted-foreground, etc.) for both the editor and the standalone source
viewer so colors follow the active theme.

## Notes

- Tailwind backward-compat aliases (`mistral`, `sunshine`) remain in the config
  for legacy class references but should not be used in new UI.
- No Waldenburg or other non-existent fonts are referenced by active code.
