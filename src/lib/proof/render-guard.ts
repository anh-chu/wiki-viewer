/**
 * Decides whether the editor's content effect should re-serialize the document.
 *
 * WHY THIS EXISTS
 * ---------------
 * The effect at `editor.tsx:752` runs `markdownToHtml()` + `setContent(html)`
 * whenever any of its dependencies change. `setContent` tears down and rebuilds
 * the whole ProseMirror document, destroying selection, scroll position and
 * decorator state — which is why `refresh(editor.view)` calls had to be patched
 * in at `:789` and `:909`.
 *
 * The effect's dependency list includes the zustand `content` field, and
 * annotation ops (comment/reply/resolve/suggestion) route through the store, so
 * every annotation triggered a full document rebuild. The `renderedKeyRef`
 * dedupe only catches *identical* content strings.
 *
 * Extracted here so the decision is a pure function: the component wires to it,
 * and `repro-annotation-reload.test.ts` proves annotation ops produce zero
 * `setContent` calls.
 */

export interface RenderInputs {
	/** The Tiptap instance exists. */
	editorReady: boolean;
	/** Path currently open in the editor. */
	currentPath: string | null;
	/** Local unsaved edits present — the stored content must not clobber them. */
	isDirty: boolean;
	/** A page fetch is in flight. */
	isLoading: boolean;
	/** Markdown held by the editor store (drives the effect). */
	content: string;
	/** Markdown actually destined for ProseMirror (e.g. viewing-mode body). */
	renderMarkdown: string;
	/** `${path} ${markdown}` of the last successful render. */
	lastRenderedKey: string | null;
	/** Path of the last successful render. */
	lastRenderedPath: string | null;
	/** An annotation (comment/suggestion) mutation occurred. */
	annotationChanged: boolean;
}

export interface RenderDecision {
	rerender: boolean;
	reason:
		| "no-editor"
		| "no-path"
		| "dirty-local-edit"
		| "loading-empty"
		| "already-rendered"
		| "annotation-only"
		| "content-changed";
}

/**
 * The single predicate that guards document re-serialization.
 *
 * Ordering matters: cheap structural guards first, then the content comparison,
 * then the explicit annotation-only exemption.
 */
export function shouldRerenderDocument(input: RenderInputs): RenderDecision {
	if (!input.editorReady) return { rerender: false, reason: "no-editor" };
	if (input.currentPath === null) return { rerender: false, reason: "no-path" };

	// An unsaved local edit outranks the stored content — never clobber it.
	if (input.isDirty) return { rerender: false, reason: "dirty-local-edit" };

	// During navigation the store briefly holds content="" while the fetch is in
	// flight; rendering that empty string is pure waste (two full schema passes).
	if (input.isLoading && input.content === "") {
		return { rerender: false, reason: "loading-empty" };
	}

	const key = `${input.currentPath} ${input.renderMarkdown}`;
	if (input.lastRenderedKey === key) {
		return { rerender: false, reason: "already-rendered" };
	}

	// Phase 5: annotation mutations are applied to ProseMirror as TRANSACTIONS
	// by their own code path. They must never route the document back through
	// markdownToHtml + setContent, because that is what destroys selection and
	// scroll (DoD #5). If the only thing that changed is annotation state, the
	// document is untouched and this effect must stand down.
	if (input.annotationChanged && !contentActuallyChanged(input)) {
		return { rerender: false, reason: "annotation-only" };
	}

	return { rerender: true, reason: "content-changed" };
}

/**
 * True when the markdown destined for ProseMirror differs from what was last
 * rendered. Compares against the key's markdown portion, ignoring the path
 * (path changes are handled by the key comparison above).
 */
function contentActuallyChanged(input: RenderInputs): boolean {
	if (input.lastRenderedKey === null) return true;
	const renderedMarkdown = input.lastRenderedKey.slice(
		(input.lastRenderedPath ?? input.currentPath ?? "").length + 1,
	);
	return renderedMarkdown !== input.renderMarkdown;
}