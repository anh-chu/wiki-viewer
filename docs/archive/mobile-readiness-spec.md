# Mobile-readiness spec

Implementation-ready spec for making wiki-viewer usable on phones/tablets. Desktop layout and behavior stay visually unchanged. Mobile is additive, gated behind a breakpoint.

Stack: Next.js 16, React 19, Tailwind 3, Radix/shadcn, TipTap 3, Zustand.

## Design principle

The app already has the two primitives we need:

1. Sidebar already has a **collapse/expand** state (`sidebarCollapsed`, local `useState` in `src/app/page.tsx:405`). When collapsed, the sidebar `Card` is unmounted and a reopen button appears top-left of the editor area (`page.tsx:~2057`).
2. AI panel is already a **fixed overlay + backdrop** driven by zustand (`useAIPanelStore.isOpen`), not part of the flex row (`src/components/ai-panel/ai-panel.tsx:152`).

So mobile work is mostly: (a) make the sidebar **overlay instead of push** on small screens, (b) auto-collapse it on mobile, (c) add a hamburger affordance, (d) cap fixed panel widths, (e) make touch-only affordances reachable, (f) fix the viewport meta. We do NOT introduce a new layout engine.

---

## 1. Breakpoint strategy

Single breakpoint. Mobile = viewport `< 768px` (Tailwind `md`). At/above `md` = desktop, unchanged.

- Tailwind prefix: `md:` is the desktop gate. Mobile styles are the unprefixed base; `md:` restores desktop.
- Rationale: one breakpoint keeps the matrix small and matches the real failure mode (3 panels do not fit on a phone; they fit fine on a ≥768px tablet in landscape and on iPad portrait). Tablets ≥768px keep the desktop 3-panel layout, which is acceptable.
- No second tier. Phone-vs-tablet nuance is not worth the complexity here.

A JS boolean is needed in a few places (auto-collapse on mount, "opening sidebar closes AI panel" logic, ignoring the resize handle). Add a `useIsMobile()` hook (section 7) backed by `matchMedia("(max-width: 767px)")`. Everything purely visual stays in Tailwind `md:` classes; only logic that branches on the boolean uses the hook.

---

## 2. Layout transformation

Desktop (`md` and up): unchanged. `flex h-screen overflow-hidden` row of [sidebar (resizable, pushes content)] + [editor flex-1] + [AI panel overlay].

Mobile (`< md`):

### Sidebar → overlay drawer (left)

- Sidebar must **overlay** the editor, not occupy a flex column. On mobile the sidebar `Card` becomes `fixed inset-y-0 left-0 z-50` with its own backdrop (`fixed inset-0 z-40`, tap-to-close). On desktop it stays in-flow (`md:static md:z-auto`, no backdrop).
- Width on mobile: `w-[85vw] max-w-[20rem]` (≈ phone-width minus a peek of the editor). Ignore the `sidebarWidth` store on mobile (section 9). On desktop keep `style={{ width: sidebarWidth }}` and `md:w-[var(...)]` is not needed because the inline style wins; instead gate the inline width so it only applies at `md+` (section 7 / component table).
- Default state on mobile: **collapsed** (closed). On first mount at mobile width, force `sidebarCollapsed = true`.
- Open trigger: hamburger button in the mobile top bar (section 3).
- Close: tap backdrop, tap a file (navigating opens the file then closes the drawer on mobile), or the existing collapse button in the sidebar header.
- Backdrop: only rendered on mobile (`md:hidden`) and only when sidebar open.
- z-index: backdrop `z-40`, sidebar `z-50`. AI panel uses backdrop `z-40` / panel `z-50` too; they are mutually exclusive on mobile (opening one closes the other, section 8) so no stacking conflict.

### AI panel → full-ish width sheet (right)

- Already an overlay. Only change: width. `w-80` becomes `w-[90vw] max-w-sm md:w-80` so it never exceeds viewport on small screens. Everything else (backdrop, Esc, focus trap) already works.

### Editor → full width

- Editor area is already `flex-1 min-w-0`. With the sidebar overlaying instead of pushing, it naturally spans full width on mobile. No change beyond the top-bar offset (section 3).

### Body scroll

- Keep `h-screen overflow-hidden` on the shell on all breakpoints. The editor body already scrolls internally (`overflow-y-auto`). Do not switch to body scroll. Reason: the editor toolbar and doc header are sticky chrome; body scroll would detach them and complicate the on-screen-keyboard case. The editor's own scroll container handles long docs.

---

## 3. Mobile top bar / chrome

Desktop has no global header; do not add one there. The editor's doc-header row already exists per-view (`page.tsx:2086`, `:2198`) and hosts the collapsed-sidebar reopen button via `pl-11` padding.

Mobile approach: **reuse the existing reopen-button slot, add an AI-panel toggle next to it.** No new full-width header bar.

- The existing `sidebarCollapsed && <PanelLeftOpen>` button (top-left, `absolute left-2 top-2`) already serves as the hamburger. On mobile the sidebar is always collapsed-by-default, so this button is the persistent menu affordance. Change: render it whenever `isMobile || sidebarCollapsed` (so it shows on mobile even though state is "collapsed"), icon stays `PanelLeftOpen` (menu-like). Keep `pl-11` header offset logic but key it on the same condition.
- Add an **AI panel toggle** button: top-right of the editor area, `absolute right-2 top-2 z-10`, `md:hidden` (desktop opens AI panel via existing mechanism/keyboard; do not change desktop). Icon: `Bot` (already imported in ai-panel; import in page). `onClick={() => useAIPanelStore.getState().open()}`. 44px tap target on mobile (section 5).
- These two floating buttons sit above the editor doc-header. They must not overlap the doc title; the existing `pl-11` already reserves left space, add matching `pr-11` on mobile when the AI toggle shows.

Rationale for no dedicated header: the per-view doc headers already carry title + actions. A second global bar would eat vertical space (precious with the on-screen keyboard up) and duplicate chrome. Floating buttons over existing chrome is the minimal, non-regressing change.

---

## 4. Touch interaction replacements

Decisive choice per item:

### Hover-gated sidebar row actions (`page.tsx:1326`, `:1861`)

- Make them **always visible on coarse pointers**. Use `@media (hover: none)` to neutralize the `opacity-0 ... group-hover:opacity-100` reveal. Add a global CSS rule in `globals.css`:
  ```css
  @media (hover: none) {
    .hover-reveal {
      opacity: 1 !important;
      max-width: none !important;
    }
  }
  ```
  Add class `hover-reveal` to the two reveal wrappers. Keeps desktop hover behavior intact; on touch the actions are simply always shown. Chosen over a per-row "..." menu because the actions already collapse cleanly and always-visible is zero new UI.

### Image resize handles (`resizable-image.tsx:100-107`)

- Same `@media (hover: none)` always-visible treatment via the `hover-reveal` class. Handles already use `onPointerDown` (touch-capable) so once visible they work. Bump handle hit area on coarse pointers to ≥24px (visually can stay small via a transparent padded hit zone) so they are tappable.

### Tree drag-reorder (`page.tsx:1202`, HTML5 `draggable`)

- **Disable on touch.** HTML5 DnD is not touch-capable and a touch DnD lib is out of scope. Set `draggable={!isMobile}`. Reordering on mobile is done via the existing context menu (long-press opens Radix `ContextMenu`, already wired at `page.tsx:1189`) which exposes move/rename actions. No new UI.

### Sidebar resize handle (`page.tsx:2009`, `onMouseDown`)

- **Hide on mobile.** The mobile sidebar is a fixed-width drawer; resizing is meaningless. Add `md:block hidden` (or render-gate on `!isMobile`). No touch handler added.

---

## 5. Tap targets

Target: 44×44 CSS px on touch (iOS HIG; covers Android 48 in practice with padding). Apply **only on coarse pointers** so desktop density is unchanged.

- Current `h-7 w-7` (28px) and `h-8 w-8` (32px) icon buttons are below target. Do not resize globally.
- Add a global rule:
  ```css
  @media (hover: none) and (pointer: coarse) {
    button,
    [role="button"],
    a.btn {
      min-height: 44px;
      min-width: 44px;
    }
  }
  ```
  Scope carefully: this can distort dense editor toolbar. Prefer a utility class `touch-target` applied to the specific mobile-critical controls (hamburger, AI toggle, sidebar row primary tap, file-tree rows) rather than all buttons, if the blanket rule visually breaks the toolbar. Implementer picks blanket vs scoped after a quick visual check; default to **scoped** to avoid toolbar regressions.
- File-tree rows: ensure row height ≥44px on coarse pointers (they are currently compact). Add `touch-target`-style min-height to the row container on mobile.

---

## 6. Viewport meta

`src/app/layout.tsx:43`, replace:

```ts
export const viewport: Viewport = {
  themeColor: "#0c0a09",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};
```

- `width: device-width`, `initialScale: 1`: standard responsive baseline.
- `viewportFit: "cover"`: needed for notch / safe-area on installed iOS PWA (status bar is `black-translucent`). Pairs with safe-area insets (section 9).
- **Do NOT set `maximumScale` or `userScalable: false`.** This is a text editor; pinch-zoom is an accessibility requirement. Allow zoom.

---

## 7. Component-by-component change list

New shared hook: `src/hooks/use-is-mobile.ts` (create `src/hooks/`).

```ts
"use client";
import { useEffect, useState } from "react";
export function useIsMobile(query = "(max-width: 767px)") {
  const [isMobile, setIsMobile] = useState(false); // SSR-safe default
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setIsMobile(mql.matches);
    on();
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, [query]);
  return isMobile;
}
```

SSR returns `false` (desktop) to avoid hydration mismatch; corrects on mount. Acceptable: first paint is desktop layout, snaps to mobile in one frame.

| File                                                   | Change                                                                                                                                                                                                                                                                                                                                                                   | Verdict gate              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `src/app/layout.tsx`                                   | Expand `viewport` export (section 6). Add safe-area CSS hook if needed.                                                                                                                                                                                                                                                                                                  | always                    |
| `src/hooks/use-is-mobile.ts`                           | New hook.                                                                                                                                                                                                                                                                                                                                                                | new                       |
| `src/app/page.tsx`                                     | Consume `useIsMobile()`. Force `sidebarCollapsed=true` on mobile mount. Sidebar `Card`: add `fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[20rem] md:static md:z-auto md:w-auto` and gate inline `style={{width}}` to desktop only (apply `width` only when `!isMobile`). Render a `md:hidden` backdrop when sidebar open on mobile. Hamburger button shows when `isMobile |                           | sidebarCollapsed`. Add `md:hidden`AI-panel toggle button (top-right). Resize handle`hidden md:block`. Tree items `draggable={!isMobile}`. On mobile, selecting a file closes the sidebar drawer. `pr-11` doc-header offset when AI toggle visible. | `md:` + hook |
| `src/components/ai-panel/ai-panel.tsx`                 | Panel width `w-80` → `w-[90vw] max-w-sm md:w-80`. No other change.                                                                                                                                                                                                                                                                                                       | `md:` only                |
| `src/components/auth-settings-sheet.tsx`               | Width `w-80` → `w-[90vw] max-w-sm md:w-80` (line ~158).                                                                                                                                                                                                                                                                                                                  | `md:` only                |
| `src/components/editor/extensions/resizable-image.tsx` | Add `hover-reveal` class to the resize-handle wrapper(s) (lines ~100-107). Enlarge touch hit area on coarse pointers.                                                                                                                                                                                                                                                    | CSS `@media (hover:none)` |
| `src/components/editor/editor-toolbar.tsx`             | Verify `overflow-x-scroll` still works with larger touch targets; if blanket 44px rule breaks it, keep toolbar buttons out of the touch-target scope. Likely no code change.                                                                                                                                                                                             | verify only               |
| `src/app/globals.css`                                  | Add `@media (hover: none)` always-visible rule for `.hover-reveal`; add scoped `touch-target` min-size rule; add safe-area padding utilities for notch (section 9).                                                                                                                                                                                                      | CSS                       |

Sidebar row reveal wrappers (`page.tsx:1326`, `:1861`): add `hover-reveal` class.

---

## 8. State management

- **Mobile sidebar drawer** reuses the existing `sidebarCollapsed` local state. No new store. `collapsed === closed` on mobile; `collapsed === pushed-off` on desktop. Same boolean, different presentation (overlay vs in-flow), gated by `md:`/`useIsMobile`.
- **AI panel** keeps its zustand `isOpen`.
- **Mutual exclusion on mobile only:** opening the sidebar calls `useAIPanelStore.getState().close()`; opening the AI panel sets `sidebarCollapsed=true`. Only do this when `isMobile` (desktop can show both). Wire in the respective open handlers in `page.tsx`.
- Persist nothing new. `sidebarWidth` store stays for desktop.

---

## 9. Edge cases

- **Orientation change:** `matchMedia` change listener re-evaluates `isMobile`; rotating a phone to landscape ≥768px wide will switch to desktop layout. Acceptable and correct. Ensure the sidebar `style` width gate re-reads `isMobile` on render (it will, via hook).
- **On-screen keyboard:** editor focus raises the keyboard, shrinking visual viewport. Because the shell is `h-screen overflow-hidden` and the editor scrolls internally, the focused caret stays in view via native scroll-into-view. Do not add JS viewport-resize handling. Verify the sticky toolbar does not cover the caret; if it does, that is a follow-up, not a blocker.
- **Safe-area insets (notch)** given `viewportFit: cover`: add safe-area padding so chrome is not under the notch/home indicator. In `globals.css`:
  ```css
  @supports (padding: max(0px)) {
    .safe-top {
      padding-top: max(0.5rem, env(safe-area-inset-top));
    }
    .safe-bottom {
      padding-bottom: env(safe-area-inset-bottom);
    }
  }
  ```
  Apply `safe-top` to the mobile floating buttons / sidebar header, `safe-bottom` to the AI panel and any bottom-anchored sheet. Desktop unaffected (`env()` is 0).
- **`sidebarWidth` store on mobile:** ignored. The drawer uses `w-[85vw] max-w-[20rem]`. Do not write to the store from mobile; do not clamp. On return to desktop the stored width applies again unchanged.

---

## Implementation order

1. `useIsMobile` hook + viewport meta (`layout.tsx`). Foundational, zero risk.
2. Width caps: `ai-panel.tsx`, `auth-settings-sheet.tsx` (`w-[90vw] max-w-sm md:w-80`). Independent, low risk, immediate win.
3. globals.css: `.hover-reveal` always-visible rule, `touch-target` scoped rule, safe-area utilities.
4. Sidebar overlay + auto-collapse + backdrop + hamburger in `page.tsx`. Core layout change.
5. AI-panel mobile toggle + mutual exclusion in `page.tsx`.
6. Touch fixes: `draggable={!isMobile}`, resize handle `hidden md:block`, `hover-reveal` on reveal wrappers + resizable-image, tree row min-height.
7. Verify editor toolbar + tap-target scoping doesn't regress desktop.

## Out of scope

- Touch drag-and-drop reordering of the file tree (use context menu instead).
- Touch-resizable sidebar (fixed-width drawer on mobile).
- Bottom-sheet redesign of the AI panel (side sheet with width cap is enough).
- Any change to desktop layout, spacing, or behavior.
- Editor on-screen-keyboard caret-tracking JS.
- New global mobile header bar.
- PWA/manifest changes (already solid).
