# Spike: marks-based tracked changes vs byte-identical Markdown

Verdict: **GO-WITH-CAVEATS** — the strip works, but the package gives you no hook for it
and `addSuggestionMarks` will silently destroy the app's schema if used naively.

> **To re-run this spike**, the two `.mjs` files here need an isolated scratch install
> (they must NOT bind to the repo root workspace). From a throwaway dir holding copies of
> `2026-09-suggest-changes-spike-proof.mjs` (renamed `proof.mjs`) and
> `2026-09-suggest-changes-spike-domboot.mjs` (renamed `dom-boot.mjs`), create:
>
> ```json
> { "name": "spike-suggest-changes", "private": true, "type": "module", "version": "0.0.0",
>   "dependencies": { "@handlewithcare/prosemirror-suggest-changes": "0.1.8",
>     "@tiptap/core": "3.31.3", "@tiptap/pm": "3.31.3", "@tiptap/starter-kit": "3.31.3",
>     "jsdom": "^30.1.0", "turndown": "7.2.4", "turndown-plugin-gfm": "1.0.2" } }
> ```
>
> plus a `.npmrc` with `shared-workspace-lockfile=false`, then `pnpm install` and `node proof.mjs`.
> The original spike pinned Tiptap 3.31.3 because 3.24.0 could not be pinned consistently in
> isolation; the serialization boundary under test (DOMSerializer + mark `toDOM`) is identical.

## What was actually run

```bash
node proof.mjs
```

Output (real):

```
baseline tiptap marks: link, bold, code, italic, strike, underline
spec.marks shape: OrderedMap
marked schema marks   : content, deletion, insertion, modification

--- A baseline HTML ---
<h1>Title</h1><p>The quick brown fox jumps.</p><p>Second paragraph here.</p>
--- A baseline Markdown ---
"# Title\n\nThe quick brown fox jumps.\n\nSecond paragraph here."

--- B DELETION-marked HTML (does it leak?) ---
<h1>Title</h1><p>The <del data-id="&quot;s2&quot;" data-inline="true">quick </del>brown fox jumps.</p><p>Second paragraph here.</p>
--- B DELETION-marked Markdown ---
"# Title\n\nThe ~quick~ brown fox jumps.\n\nSecond paragraph here."

--- C DELETION-marked, stripped HTML ---
<h1>Title</h1><p>The quick brown fox jumps.</p><p>Second paragraph here.</p>
--- C DELETION-marked, stripped Markdown ---
"# Title\n\nThe quick brown fox jumps.\n\nSecond paragraph here."

--- D INSERTION-marked HTML ---
<h1>Title</h1><p>The <ins data-id="&quot;s1&quot;" data-inline="true">very </ins>quick brown fox jumps.</p><p>Second paragraph here.</p>
--- D INSERTION-marked Markdown ---
"# Title\n\nThe very quick brown fox jumps.\n\nSecond paragraph here."
--- E INSERTION-marked, stripped Markdown ---
"# Title\n\nThe very quick brown fox jumps.\n\nSecond paragraph here."

=== ASSERTIONS ===
1. deletion mark leaks into markdown (B != A) : true
2. DELETION stripped => byte-identical to A    : true
3. INSERTION stripped => keeps inserted text  : true
```

## Package API surface (from shipped .d.ts, v0.1.8)

`dist/index.d.ts` exports exactly:

- schema: `addSuggestionMarks`, `insertion`, `deletion`, `modification` (MarkSpecs)
- plugin: `suggestChanges()` -> plain ProseMirror `Plugin`, `suggestChangesKey`,
  `isSuggestChangesEnabled`
- transaction decorator: `withSuggestChanges`, `transformToSuggestionTransaction`
- commands: `applySuggestion(s)`, `revertSuggestion(s)`, `selectSuggestion`,
  `enable/disable/toggleSuggestChanges`

It is **ProseMirror-native**: no TipTap `Extension`, no `@tiptap/*` peer, no NodeView.
Instantiating it under TipTap requires wrapping `suggestChanges()` in a custom
`Extension.create({ addProseMirrorPlugins() { return [suggestChanges()] } })`.
`decorations.d.ts` also exports `getSuggestionDecorations` (not re-exported from index).

Mark names: `insertion`, `deletion`, `modification`.
`toDOM`: insertion -> `<ins data-id data-inline>`, deletion -> `<del data-id data-inline>`,
modification -> `<span data-type="modification">`.

**There is no serialization/mark-filter hook anywhere** — not in `index.d.ts`, not in the
README, and the word "filter" appears nowhere in the README.

## Two defects found by running it

1. `addSuggestionMarks(marks)` spreads the map you give it. Passing TipTap's
   `schema.spec.marks` (an **OrderedMap**) yields only `content, deletion, insertion,
   modification` — every real TipTap mark (`bold`, `italic`, `link`, `code`, `strike`,
   `underline`) is silently lost. The input must be converted to a plain object first.
2. TipTap resolves its schema once at `new Editor()`. The suggestion-enabled schema must
   be built as a TipTap extension, not by handing a modified `Schema` to `getHTML()`.
   A custom TipTap `Mark` per suggestion mark is the supported route (README's
   `Schema({ nodes, marks: addSuggestionMarks(marks) })` is raw-ProseMirror guidance).

## Compatibility

| Fact | Value |
| --- | --- |
| version / published | 0.1.8, 2025-11-18 |
| license | MIT |
| runtime deps | 0 (peers only) |
| peers | prosemirror-model/state/view/transform `^1.0.0` |
| downloads | 257,744 last month; 60,717 last week |
| repo installed TipTap | 3.24.0 (`package.json` declares `^3.22.5`) |
| repo ProseMirror | model 1.25.7, state 1.4.4, view 1.41.8, transform 1.12.0 |
| peer overlap | full — all four `^1.0.0` ranges satisfied |

No `@tiptap/*` peer constraint exists, so there is nothing to be incompatible with.
`pnpm peers check` in the scratch dir: "No peer dependency issues found".

Caveat: the proof ran against TipTap **3.31.3** in the scratch dir (3.24.0 could not be
pinned consistently — `@tiptap/extension-list@3.31.3` is pulled transitively by
StarterKit and requires `@tiptap/core@3.31.3` exports). The serialization boundary
(`DOMSerializer` + mark `toDOM`) is identical across both.

## Strip point in the app

`src/components/editor/editor.tsx:512` — `const html = editor.getHTML();` inside
`handleUpdate` (declared line 509), feeding `htmlToMarkdown(...)` at line 513 and
`updateContent(md)` at line 517.

A filter **is required**. `getHTML()` serializes the live doc via ProseMirror's
`DOMSerializer`, which emits `<ins>`/`<del>` for these marks; Turndown then turns
`<del>` into GFM `~quick~` (proved above). Nothing in the package prevents this.

Recommended hook (one line of real change): serialize from a filtered clone of the doc,
e.g. `editor.getHTML()` -> replace with a `serializeWithoutSuggestionMarks(doc)` helper
next to `htmlToMarkdown` in `src/lib/markdown/to-markdown.ts:280`, deleting nodes inside
`deletion` and dropping all three marks. Alternatively add a Turndown rule, but that
still leaves `<ins>`/`<del>` in any HTML path and is weaker.

`src/lib/proof/suggestion-decorator.ts` is unaffected either way: current redlines are
ProseMirror `Decoration`s, which by construction never enter `getHTML()` or the doc.
Adopting marks trades that structural guarantee for markup that must be stripped on
every save path. Sidecar revisions are untouched by both approaches — suggestions live
in `.proof/` sidecars, not in the `.md` file.

## Biggest risk

Marks live **in the document**, so any save path that does not go through the single
filtered serializer (autosave, agent tier-1 raw write, copy-as-prompt, export, share)
will persist `~deleted~` redlines into the canonical `.md`. Decorations cannot leak this
way; marks can. The byte-identity property holds only for save paths that are all
routed through the filter — that is an invariant to enforce, not a property of the package.

## Files

- `proof.mjs` — the runnable proof (assert-based)
- `dom-boot.mjs` — jsdom bootstrap, imported before TipTap
- `pkg-sc/package/` — extracted tarball (dist/*.d.ts, README.md, LICENSE)
- `meta-suggest-changes.json`, `meta-react-pm.json` — registry metadata
- `package.json`, `pnpm-workspace.yaml`, `.npmrc` — isolated scratch install