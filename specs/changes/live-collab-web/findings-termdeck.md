> SUPERSEDED for the v1 shape. TermDeck is retained here as *ideation reference
> only*. The actual build target is impeccable-grade (variant preview bound to an
> immutable candidate source patch, write-on-accept). See `proposal.md`. Do not
> implement the shallow "prose to agent, reload" model described at the bottom of
> this file.

# Gap 2 research: TermDeck's "Tweak mode" and what it means for wiki-viewer

Source studied: `huytieu/termdeck-localterm` (a fork of `localterm`, whose wiki
is itself *inspired by wiki-viewer*). Commit `25e6850`. The relevant feature is
**Tweak mode**: "point at the pixel, the agent gets the selector."

## What TermDeck actually built

Much simpler than impeccable. No HMR, no variants, no DOM→source localization,
no write-on-accept. The whole thing is ~200 lines of injected JS + a proxy + a
prose message to a terminal agent. Three pieces:

### 1. An injected element-picker script (`packages/server/src/artifact-picker.ts`)
A self-contained IIFE (`ARTIFACT_PICKER_JS`) appended into any rendered HTML.
- Hover highlights the element under the cursor (`elementFromPoint`), click marks it.
- Builds a **robust CSS selector** by walking up ≤6 ancestors: prefers `#id`
  (and stops), else `tag.class1.class2` (first two non-picker classes), adds
  `:nth-of-type(n)` only when siblings share the tag. (`cssPath()`)
- Captures a **snippet** (`outerHTML`, truncated to ~400 chars → open tag + text)
  and the element's `textContent` (≤200 chars).
- Talks to the parent **only via `window.postMessage`** — protocol
  `{source:'termdeck-picker', cmd:'enable'|'disable'|'remove'|'clear'}` down,
  `{event:'ready'|'selected', id, selector, tag, snippet, text, rect}` up.
- Because it's postMessage-only, it works from a **sandboxed null-origin iframe**
  (no `allow-same-origin` needed). Overlay chrome is fixed-position, pointer-events
  none, huge z-index, and self-marked so it never picks itself.

### 2. Two HTML surfaces get the picker (`apps/terminal/src/components/wiki-detail.tsx`)
- **Local `.html` file** → rendered via `srcDoc`, with `<script src="/api/artifact/picker.js">`
  appended before `</body>`.
- **Remote deploy URL** → fetched server-side through `/api/artifact/proxy`, which
  strips CSP `<meta>`, injects a `<base href>` so relative assets resolve to the
  real origin, and **inlines** the picker (`injectArtifactChrome`). Manual redirect
  following detects cross-host SSO gates and shows a readable notice instead of a
  blank login page.
- The parent React component bridges: translates the in-frame element rect to page
  coords (using the iframe's own offset) and anchors a "what should change?" note
  popover. One pending pick at a time; a batch tray stacks several.

### 3. Dispatch is just prose to a terminal (`sendTweaks`)
No structured edit protocol at all. It formats:
```
In the artifact `path`, apply these N edits to the matching elements:

Tweak 1 — `selector` (<tag>):
  Current: <snippet>
  Change: <your note>
```
…and sends it as one chat message into the linked terminal session (`chatAboutSelection`).
The agent (Claude in a shell) reads it, finds the source, edits the file itself, the
dev server/HMR reloads the iframe. Accept/revert is just "look at the page again."

## How this maps onto wiki-viewer

We are closer than TermDeck was, in the parts that matter:

- **Injection seam already exists.** `src/app/api/app-proxy/[...path]/route.ts`
  already `rewriteHtml()`s proxied app HTML and injects a `<script>` + a service
  worker. Adding a picker `<script>` is the same move TermDeck makes.
- **Sandbox already correct.** `website-viewer.tsx` sandboxes without
  `allow-same-origin`; a postMessage-only picker fits that exactly (per AGENTS.md
  security model: never combine `allow-scripts` + `allow-same-origin`).
- **We already have live presence + a real dispatch channel.** TermDeck fires a
  prose message into a terminal. We have the live-collab control plane
  (`/api/wiki/live/request` → attached agent → reply). A web "tweak" is just a
  new live request `kind` carrying `{selector, tag, snippet, note}` instead of
  `{blockRef, instruction}`.

What we do NOT get for free, and what makes web genuinely different from markdown:

- **No source identity.** For markdown, a block-ref maps a rendered node to a
  canonical source region and the edit commits through tier-2. For an arbitrary
  HTML app, a CSS selector does **not** identify a source location — the agent
  must *find* where that element is generated (JSX, template, framework) and edit
  that. That search is the agent's job (exactly as in TermDeck), not the protocol's.
- **No activity/audit provenance / accept-revert.** The edit lands in real source files via tier-1
  raw FS (or the agent's own shell), not as a reviewable block-op. Review is
  "reload the preview." This is a *different persistence model* and must not be
  bolted onto the tier-2 engine.

## Recommended shape for wiki-viewer Gap 2 (v1)

Steal TermDeck's model almost verbatim, ride our existing rails:

1. **Picker script** served/injected into (a) local `.html` previews via `srcDoc`
   and (b) proxied node-apps via the existing `rewriteHtml` seam. postMessage-only.
   Reuse TermDeck's `cssPath`/`snippet` logic (MIT — reimplement, credit in comment).
2. **Element-select UX** in `website-viewer.tsx` / `node-app-viewer.tsx`: a "Tweak"
   toggle, hover highlight, click → note popover, optional batch tray.
3. **Dispatch via live channel**, new request kind `tweak` (or `web.tweak`):
   `{ path, selector, tag, snippet, note }`. The attached agent receives it on poll.
4. **Agent edits real source** through tier-1 raw FS (`/api/agent/fs/*`), not tier-2.
   No activity/audit provenance. The preview reloads (node-app HMR, or re-fetch for static HTML).
5. Explicit non-goals for v1: no HMR variant preview, no write-on-accept staging,
   no DOM→source auto-localization, no CSS-only inline patching. The agent finds
   and edits source, same as a human would from a bug report.

## The load-bearing decision (needs Anh)

Web tweak is a **second persistence model** (edit real source, reload preview),
distinct from markdown live (block-op activity/audit provenance, activity tracking). That is fine and
matches reality — but it means "live collaboration" becomes an umbrella over two
concretely different flows. Options:

- **A. Two explicit modes under one presence channel** (recommended): same attach/
  poll/reply + session, request `kind` distinguishes `generate|steer` (markdown,
  tier-2) from `tweak` (web, tier-1). One agent runtime handles both. Honest about
  the two persistence models; minimal new surface.
- **B. Keep web tweak entirely separate** (TermDeck-style, prose to a terminal),
  not wired to the proof/live stack at all. Simplest, but throws away the presence
  channel we just built and duplicates dispatch.

Recommend A. Ship the picker + element UX first (pure frontend + injection, no
protocol risk), then wire the `tweak` request kind onto the existing live channel.
