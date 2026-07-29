# Changelog

## Versioning posture

A consumer pins this package exactly, so the version is the only signal they get
that rendering changed.

- **Patch** — any change to rendered output, sanitizing, or shipped CSS. Every
  render-layer fix gets one. There is no "too small to bump" change here, because
  the whole point of the package is that its output is predictable.
- **Minor** — new exports, new options, or a widened styling contract.
- **Major** — a change that breaks a consumer: renaming exports, changing the
  kind mapping, or requiring a host token beyond `--background`/`--foreground`.
- Security fixes are released as their own patch, never bundled with features, so
  a consumer can take them without reviewing anything else.

While at `0.x`, treat minor as potentially breaking.

## 0.1.0 — unreleased

First extraction from the wiki-viewer app. Everything below was found and fixed
BEFORE first publish, mostly by two sessions checking each other's artifacts rather
than each other's descriptions. Recorded because each one is now a gate.

### Security

- Markdown sanitizing is ON by default. It had been switched off to win a
  byte-parity test against the app's editing path, which let `<script>` and
  `onerror` through into the consumer's origin.
- `class` reduced to an allowlist and inline `style` removed, so an untrusted file
  cannot use the host's own utilities to paint a full-screen fake UI.
- HTML files framed with `sandbox=""`; previously `allow-scripts allow-same-origin`,
  which cancels the sandbox and hands the frame the host's origin.
- Embed `iframe` src restricted to the providers the pipeline itself emits, and
  iframes whose src does not survive sanitizing are removed entirely rather than
  left as same-origin `about:blank` frames.

### Correctness

- Bundle is isomorphic. A transitive dependency's browser build ran
  `document.createElement` at module scope, so importing the package threw in any
  server runtime while `next build` still exited 0.
- Sanitizing no longer strips `class="wiki-link"` / `class="task-list"`.
  `defaultSchema` pins `className` to single values on `a` and `ul`, so appending a
  bare `className` had no effect and the attribute shipped empty.
- Opacity utilities emit CSS. Colour tokens were plain `var()` strings, which
  Tailwind cannot apply an alpha modifier to, so 23 utilities silently produced
  nothing (missing CSV header backgrounds, row hover, outline highlight).
- Restored coarse-pointer affordances for image resize handles, lost when app-shell
  CSS was pruned; without them the handles never appear on a touch device.
- Removed an unreachable `hljs-10`-era selector that made `.hljs-title` look
  doubly declared.

### Styling

- Ships structural CSS only: no `:root` palette, no Tailwind preflight, no global
  reset, nothing outside `.wv-viewer-root`.
- Requires only `--background` and `--foreground`; all other tokens are derived via
  `color-mix`, measured at 5.37:1 worst case across dark and light hosts.
- Syntax hues survive an achromatic host instead of collapsing to greyscale.
- Optional `theme.css` carries wiki-viewer's own palette.
- Dropped 462 lines of app-shell CSS that no component referenced.
