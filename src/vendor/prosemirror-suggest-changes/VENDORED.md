# Vendored: @handlewithcare/prosemirror-suggest-changes 0.1.8

Google Docs-style tracked suggestions for ProseMirror. MIT.

- Source: https://github.com/handlewithcarecollective/prosemirror-suggest-changes
- Tarball: https://registry.npmjs.org/@handlewithcare/prosemirror-suggest-changes/-/prosemirror-suggest-changes-0.1.8.tgz
- SHA-1 of the tarball: `707d432376718d4618065b22aafbc55b9ce4ea5b` (verified against the registry)

## Why vendored, not a dependency

The package is pre-1.0 (0.1.8), so its API can shift. It is ~1,200 lines with no
runtime dependencies, so vendoring costs nothing and keeps the integration and
its fixes in this tree.

## The one edit made to the source

Every `import ... from "prosemirror-<sub>"` was rewritten to
`import ... from "@tiptap/pm/<sub>"`, in both the `.js` sources (8 files, 9 lines) and
the `.d.ts` declarations (16 files).

The package declares `prosemirror-state`, `-view`, `-model` and `-transform` as
peer dependencies. pnpm does not hoist those, and this app has no top-level
`prosemirror-*` packages — it uses `@tiptap/pm`, which bundles the same
ProseMirror build. Both alternatives were tried and rejected:

- **tsconfig `paths` aliases.** Retroactively changed module resolution for every
  existing file in the project and produced 107 type errors, because the app
  already imports ProseMirror through `@tiptap/pm/*` and those imports stopped
  resolving the same way.
- **Shim modules re-exporting the names.** Fixed the runtime but not the types: a
  shim exporting runtime values cannot satisfy `import type { X } from
  "prosemirror-state"`, which surfaced as 43 "refers to a value but is being used
  as a type" errors.

Rewriting the imports touches only the vendored files and leaves the rest of the
app's module resolution alone. ## Local edits beyond the import rewrite

Two behavioural fixes in `commands.js`, both marked `LOCAL EDIT (wiki-viewer)` inline
and both reported by adversarial review. Upstream 0.1.8:

1. Passed `undefined` instead of `suggestionId` to `applyModificationsToTransform` in
   both `applySuggestion` and `revertSuggestion`. That function already scopes by id
   via `modificationIsInSet`, so the id being dropped meant approving one card applied
   every modification inside the range, including another suggestion's.
2. `revertSuggestion` returned early on `!tr.steps.length` BEFORE the modification
   pass. A modification-only suggestion leaves insertion/deletion marks untouched, so
   that early return made rejecting one a silent no-op. The check now runs after the
   modification pass, where it still correctly reports "nothing happened".

3. `revertModifications` called `tr.setNodeAttribute` for an `attr` modification even
   when the mark sat on a TEXT node, where ProseMirror throws
   `NodeType.create can't construct text nodes` and the whole revert fails. Text nodes
   carry no attributes, so there is nothing to restore and the branch is now skipped
   for them.

4. `revertModifications` threw `Unknown modification type` for `type: "text"`, even
   though this app writes `"text"` as the default modification type. A text
   modification records a wording change, so there is no node state to restore and
   dropping the mark is the revert; only genuinely unknown types throw now.

All four are narrow and carry inline comments; the rest of the vendored code is
unmodified.
