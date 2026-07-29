# @wiki-viewer/viewer

Read-only file viewer extracted from [wiki-viewer](https://github.com/anh-chu/wiki-viewer):
Markdown (Tiptap + remark/rehype), source code, CSV, images, PDFs, media, HTML and
binary files. Renders byte-identically to wiki-viewer's own shared-document page.

```tsx
import { FileViewer, fileKindFor } from "@wiki-viewer/viewer";
import "@wiki-viewer/viewer/styles.css";

<FileViewer kind={fileKindFor(name)} filename={name} content={text} />;
```

## File kinds

`fileKindFor(filename)` returns one of two families, and which one decides whether
you must pass `content` or `assetUrl`:

| family    | kinds                                        | prop       |
| --------- | -------------------------------------------- | ---------- |
| text      | `markdown` `source` `text` `csv` `html`      | `content`  |
| asset     | `image` `pdf` `media` `binary`               | `assetUrl` |

`html` is a TEXT kind: it is framed with `<iframe srcDoc>`, so it needs the file
body rather than a URL.

## Security defaults

The package assumes the files it renders are UNTRUSTED, because a viewer's input
usually is.

- **Markdown is sanitized by default.** The pipeline uses `rehype-raw`, so raw HTML
  in a file is expanded, then filtered: `<script>`, event handlers, `javascript:`
  and `vbscript:` URLs, `<object>`, `<embed>`, `<form>`, `<svg>`, `<base>` and
  inline `style` are all removed. `class` is reduced to an allowlist so a file
  cannot borrow the host's utility classes to paint a fake UI, and `id` is
  namespaced so it cannot collide with host element ids.
- `renderMarkdownToHtml(md, { sanitize: false })` exists for trusted content only.
  It is unsafe by design and must be requested by name.
- **HTML files are framed with `sandbox=""`.** No `allow-scripts`, no
  `allow-same-origin`. Those two together cancel sandboxing, and a frame that
  reaches the host origin can reach everything the host's cookies can.
- Embed iframes are restricted by URL to the providers this pipeline generates.

## Styling contract

Import `@wiki-viewer/viewer/styles.css`. It is structural only:

- **Nothing applies outside `.wv-viewer-root`.** No `:root` palette, no Tailwind
  preflight, no global reset, no element-level rules. The scoped reset uses
  `:where()` so it carries zero specificity and never outranks your utilities.
- **The host must define only `--background` and `--foreground`.** Every other
  token is derived from those two with `color-mix`, so contrast holds on a dark
  host and a light one alike; the measured floor is 5.37:1 against WCAG AA's 4.5:1.
  No other host custom property is read, so nothing can collide with your tokens.
- Syntax colours keep hardcoded hue anchors mixed toward your foreground, so
  highlighting stays green/amber/red even on a fully achromatic palette instead of
  collapsing to legible-but-useless greyscale.
- Want wiki-viewer's own look instead? Also import
  `@wiki-viewer/viewer/theme.css`.

## SSR

The bundle is isomorphic: importing it in a server runtime with no DOM is safe, and
`renderMarkdownToHtml` works there. (It did not always: a transitive dependency's
browser build ran `document.createElement` at module scope, which 500'd every
server-rendered page that imported this package.)

## Verification

```
npm run verify   # 51 assertions, also run by build, prepack and prepublishOnly
```

Covering: artifact freshness, bare-Node import, XSS vectors, UI-spoofing vectors,
sandbox flags, CSS containment, CSS completeness (every class the components use is
actually emitted), and measured WCAG contrast on both a dark and a light host. Each
assertion names the defect that motivated it. Every gate prints the sha256 and build
time of the artifact it measured, so a result can always be attributed to a build.
