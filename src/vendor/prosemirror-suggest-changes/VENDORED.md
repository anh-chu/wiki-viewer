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
app's module resolution alone. The vendored code is otherwise unmodified.
