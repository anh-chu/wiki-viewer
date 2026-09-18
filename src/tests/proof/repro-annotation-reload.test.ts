/**
 * PHASE 1 REPRO #2 — annotation ops must not re-serialize the document.
 *
 * User symptom: "unusable in practice" — every comment/suggestion reloads the
 * whole document.
 *
 * MECHANISM (confirmed in the research session):
 *   annotation op → loadSidecar → zustand store mutation → editor re-render →
 *   the content effect at editor.tsx:752 runs → markdownToHtml() →
 *   editor.commands.setContent(html)
 *
 * `setContent` tears down and rebuilds the entire ProseMirror document, which
 * destroys selection, scroll position and decorator state — hence the
 * `refresh(editor.view)` patches at editor.tsx:789 and :909.
 * `renderedKeyRef` dedupes only *identical* content strings, so it does not
 * help: a reply adds a turn to the sidecar without changing the markdown, but
 * any store-driven re-render still walks the effect.
 *
 * The bug lives in a React effect, so it cannot be asserted by importing the
 * component in the pure-Node test runner. Instead this test drives the exact
 * decision logic the effect performs — extracted as `shouldRerenderDocument` —
 * so the fix is provable now and the component wires to the same predicate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	shouldRerenderDocument,
	type RenderInputs,
} from "../../lib/proof/render-guard.js";

/** The state the content effect reads, as it stands after an annotation op. */
function afterAnnotationOp(overrides: Partial<RenderInputs> = {}): RenderInputs {
	return {
		editorReady: true,
		currentPath: "notes/doc.md",
		isDirty: false,
		isLoading: false,
		content: "# Title\n\nBody text.\n",
		renderMarkdown: "# Title\n\nBody text.\n",
		lastRenderedKey: "notes/doc.md # Title\n\nBody text.\n",
		lastRenderedPath: "notes/doc.md",
		revisionChanged: false,
		annotationChanged: true,
		...overrides,
	};
}

test("repro-annotation-reload: a comment reply must NOT re-serialize the document", () => {
	// A reply mutates sidecar turns only. The markdown is byte-identical and the
	// rendered key is unchanged, so there is no reason to touch ProseMirror.
	const decision = shouldRerenderDocument(afterAnnotationOp());

	assert.equal(
		decision.rerender,
		false,
		"BUG (DoD #5): a comment reply must produce ZERO markdownToHtml + setContent calls",
	);
	assert.equal(decision.reason, "already-rendered");
});

test("repro-annotation-reload: resolving a comment must NOT re-serialize", () => {
	const decision = shouldRerenderDocument(
		afterAnnotationOp({ annotationChanged: true }),
	);
	assert.equal(decision.rerender, false, "resolve is a sidecar-only change");
});

test("repro-annotation-reload: accepting a suggestion must NOT re-serialize here", () => {
	// Accept changes the markdown, but it is applied as a ProseMirror
	// TRANSACTION (Phase 5), not by re-stamping HTML through setContent.
	const decision = shouldRerenderDocument(
		afterAnnotationOp({ annotationChanged: true, revisionChanged: true }),
	);
	assert.equal(
		decision.rerender,
		false,
		"accept must apply via transaction; re-serializing destroys selection + scroll",
	);
});

test("repro-annotation-reload: a real page navigation DOES re-render", () => {
	// Guard against the fix over-reaching: navigation must still render.
	const decision = shouldRerenderDocument(
		afterAnnotationOp({
			currentPath: "notes/other.md",
			content: "# Other\n\nDifferent body.\n",
			renderMarkdown: "# Other\n\nDifferent body.\n",
			lastRenderedKey: "notes/doc.md # Title\n\nBody text.\n",
			annotationChanged: false,
		}),
	);
	assert.equal(decision.rerender, true, "navigating to a new page must render it");
	assert.equal(decision.reason, "content-changed");
});

test("repro-annotation-reload: an external file change DOES re-render", () => {
	const decision = shouldRerenderDocument(
		afterAnnotationOp({
			content: "# Title\n\nBody text edited elsewhere.\n",
			renderMarkdown: "# Title\n\nBody text edited elsewhere.\n",
			annotationChanged: false,
		}),
	);
	assert.equal(decision.rerender, true, "external edits must reach the editor");
	assert.equal(decision.reason, "content-changed");
});

test("repro-annotation-reload: a dirty local edit suppresses the refetch render", () => {
	const decision = shouldRerenderDocument(
		afterAnnotationOp({
			isDirty: true,
			content: "# Title\n\nLocal unsaved edit.\n",
			renderMarkdown: "# Local\n\nBody text.\n",
			annotationChanged: false,
		}),
	);
	assert.equal(
		decision.rerender,
		false,
		"an unsaved local edit must not be clobbered by the stored content",
	);
});

test("repro-annotation-reload: an identical re-fetch is deduped", () => {
	const decision = shouldRerenderDocument(afterAnnotationOp({ annotationChanged: false }));
	assert.equal(decision.rerender, false, "identical (path, content) is already deduped today");
});