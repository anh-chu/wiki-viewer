# Proposal: impeccable-grade live collaboration for web surfaces

## Problem

Live collaboration (markdown) shipped: point at a rendered block, an attached
agent edits it in-session, the change lands as a reviewable activity/audit provenance. That
covers `.md`. It does **not** cover the web surfaces wiki-viewer renders in an
iframe: local `.html` previews (`website-viewer`) and running node-apps behind
`app-proxy` (`node-app-viewer`).

For web, the analogous experience is impeccable's: point at a rendered DOM
element, describe the change, **see it applied live on the real page before
anything is written**, then accept (commit to source) or discard (revert, source
never touched). We want that experience baked in, at impeccable's depth, not a
shallow "send a note to a terminal" imitation.

## Desired outcome

In a web preview, the user toggles **Tweak** mode, clicks an element, and types
what should change. The attached agent returns a **preview patch** that is
applied inside the iframe via postMessage, so the user sees the variant on the
live page immediately. The user then:

- **Accept** → agent writes the real source (tier-1 raw FS); preview reload
  reflects the committed change.
- **Discard** → the DOM patch is reverted in-frame; no source was touched.

Same attach / poll / reply presence channel already built for markdown. One
attached agent runtime handles both markdown (`generate`/`steer`) and web
(`web.tweak`) requests.

## Why this is achievable with minimum new machinery

Impeccable's expensive invention was the variant hot-swap pipeline. We get the
equivalent almost free because our web surfaces are **already iframes** and we
already have a **postMessage element picker** (`src/lib/web-tweak/picker.ts`):

- **Variant preview = a DOM/CSS patch applied inside the iframe**, not an HMR
  rebuild. The picker gains `apply`/`revert` commands; the parent posts the
  agent's patch in, the element visibly changes, the original is retained for
  revert. The DOM patch is the *rendering* of the variant; the bound candidate
  source patch is the *thing accept commits*. Both are produced by the single
  `web.tweak` reply so accept never re-synthesizes.
- **Presence + dispatch already exist** (the live channel we shipped).
- **Injection seam already exists**: `app-proxy` `rewriteHtml()` injects scripts
  into proxied app HTML; static `.html` can carry the picker via `srcDoc` or the
  assets route. The picker is postMessage-only, so it runs in the existing
  no-`allow-same-origin` sandbox with no security regression.
- **Source write already exists**: tier-1 raw FS (`/api/agent/fs/*`).

## The deliberate divergence: write-on-accept

Web live is **write-on-accept**: source is untouched until the user accepts a
previewed variant. This is the *opposite* of markdown live (write-first, then
review the activity/audit provenance). That divergence is intentional and is *why* the claim
holds. Each surface uses the persistence model that is impeccable-grade for it:

| | Markdown live | Web live (this) |
|---|---|---|
| Preview | activity/audit provenance in TipTap over real file | DOM patch in iframe, source clean |
| Persistence | write-first, activity tracking span | write-on-accept to real source |
| Write path | tier-2 block-ops | tier-1 raw FS |
| Identity | block-ref → source region | CSS selector (agent localizes source) |

Both ride one presence channel and one agent runtime. Two persistence models,
one product promise.

## The preview transaction (the core object)

Identity for a web tweak is NOT just a CSS selector. Every tweak is a versioned
**preview transaction**, keyed by a server-issued `previewId`:

```
previewId
  ->  selected DOM fingerprint  (selector, tag, snippet, text)
  ->  domPreviewOps             (ephemeral, applied in-frame; data-only)
  ->  candidateSourcePatch      (immutable; the exact edit accept will write)
  ->  baseFiles[]               ({ path, sha256 }) the candidate was derived against
  ->  status                    requested | preview-ready | accepted | discarded | invalidated
```

`web.tweak` reply MUST carry both `domPreviewOps` and `candidateSourcePatch`
plus `baseFiles`. Accept commits `candidateSourcePatch` verbatim **iff** every
`baseFiles[].sha256` still matches on disk; otherwise the transaction is
`invalidated` (user re-tweaks). Accept never re-localizes or re-synthesizes.
This is what makes it a *reviewed variant* rather than a *visual proposal*.

## Scope

1. Extend the picker protocol with `apply`/`revert` (ephemeral DOM patch inside
   the iframe) plus original-state retention. Patch language is **data-only**:
   text, attributes (denylist: event handlers, `javascript:` URLs, script/iframe
   insertion, form/nav targets), and inline style. No arbitrary JS/eval.
2. New live request kind `web.tweak` carrying `{ path, previewId, selector, tag,
   snippet, note }`; agent reply carries `{ domPreviewOps, candidateSourcePatch,
   baseFiles }`. The candidate source patch is derived at reply time, not accept.
3. Accept/discard control plane on the live channel: `web.accept` / `web.discard`
   reference a `previewId`. `web.accept` verifies `baseFiles` hashes then commits
   `candidateSourcePatch` via tier-1; mismatch -> `invalidated`, no write.
4. Mount Tweak UX in `website-viewer.tsx` and `node-app-viewer.tsx`: toggle,
   hover highlight (from picker), note popover, preview state, accept/discard bar.
   Accept/Discard originate ONLY from trusted parent UI, never from an iframe
   message.
5. Inject the picker: proxied apps via `rewriteHtml`; static `.html` via the
   assets/srcDoc path.
6. Agent runtime: extend `runLiveLoop` to handle `web.tweak` (produce DOM preview
   ops AND candidate source patch + base hashes in one reply) and `web.accept`
   (verify hashes, tier-1 write). Passthrough reference handler for smoke tests.

## Message-trust rules (iframe -> parent)

Every iframe->parent message is hostile input:

- Verify `event.source === iframe.contentWindow` (opaque origin makes
  `event.origin` checks insufficient on their own).
- Strict schema validation; reject unknown fields/types.
- Iframe messages may only carry *selection* facts (selector/snippet/rect). They
  MUST NOT be able to trigger a filesystem write or an accept. Accept/discard are
  driven by parent control state keyed on `previewId`.
- No nonce is assumed secret from page JS sharing the frame.

## v1 surface note (post-review)

Web tweak in v1 is offered **only on the opaque-origin static-HTML preview**
(the `srcDoc` path in `website-viewer`). It is intentionally **not** offered for
running node-apps: the proxied app is served from the wiki-viewer origin with an
`allow-same-origin` iframe (required for the app to run), so hostile page JS
could reach `parent.document` and click Accept, bypassing the postMessage
boundary. Node-app tweak requires a dedicated isolated proxy origin and is
deferred. The picker is still injected into proxied HTML (harmless, inert without
parent postMessage) so the capability is ready once an isolated origin exists.

## Non-goals (v1)

- No HMR/build-pipeline variant rebuild (DOM patch preview is the mechanism).
- No automatic DOM→source localization by the *protocol*; the agent finds the
  source (as a human would), the selector+snippet+note is its lead.
- No multi-variant A/B stacks; one pending preview per element.
- No CSS-only inline persistence; accept always writes real source.
- No collaboration on third-party remote sites we don't own the source for.
- No change to the markdown tier-2 engine (must not bolt web preview onto it).

## Risks

- **Preview/source fidelity gap** (the main risk): a DOM mutation may map to a
  materially different source change (CSS token vs prop vs conditional vs shared
  class), a framework re-render may overwrite the DOM patch, or one rendered
  instance may map to a component affecting many instances. Mitigation: the
  candidate source patch is produced *with* the preview and bound to `previewId`;
  accept commits that candidate, and the post-accept reload is *verification*
  (does the reviewed candidate render as expected), not the first time source is
  interpreted. If the agent cannot produce a confident candidate patch at
  `web.tweak` time, it returns preview-only with `candidateSourcePatch: null` and
  the UI shows "visual only, not acceptable" rather than offering a false accept.
- **Base drift between preview and accept**: user, watcher, HMR, or another agent
  changes the source files after preview. Mitigation: accept verifies
  `baseFiles[].sha256`; any mismatch invalidates the transaction (no write, user
  re-tweaks). Never opportunistically rebase.
- **Two persistence models** invite confusion. Mitigation: explicit request-kind
  namespacing (`web.*`), separate write path, this spec's boundary table, and a
  line-review rule: `web.*` never touches tier-2, markdown never touches tier-1.
- **Sandbox**: keep postMessage-only; never add `allow-same-origin` to a
  script-enabled preview.

## Acceptance criteria

- Toggling Tweak in a web preview highlights elements on hover and captures a
  selector+snippet on click.
- A note dispatched for a selected element reaches the attached agent as a
  `web.tweak` request on the existing poll channel, carrying a `previewId`.
- The `web.tweak` reply produces a preview transaction with `domPreviewOps`,
  `candidateSourcePatch` (or explicit null), and `baseFiles` hashes.
- The DOM preview ops are applied inside the iframe and visibly change the live
  page with no source file changing (verified: file sha256/mtime unchanged).
- Discard reverts the element to its original state in-frame; source unchanged.
- Accept with matching `baseFiles` hashes writes `candidateSourcePatch` via
  tier-1 and reloads the preview; accept with a stale hash invalidates and writes
  nothing.
- A `candidateSourcePatch: null` transaction offers no accept (visual only).
- An iframe->parent message cannot trigger a write or accept; accept/discard come
  only from parent control state. (protocol-abuse test)
- `event.source` identity is verified on picker messages. (protocol-abuse test)
- No `allow-same-origin` is combined with `allow-scripts` on any tweak preview.
- Markdown live behavior and tier-2 engine are unchanged (existing tests green).
