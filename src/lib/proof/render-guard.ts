/**
 * Decides whether the editor's content effect should re-serialize the document.
 *
 * The effect runs `markdownToHtml()` + `setContent(html)` when its dependencies change,
 * and `setContent` tears down and rebuilds the whole ProseMirror document — destroying
 * selection, scroll position and decorator state. The effect depends on the zustand
 * `content` field, which annotation ops also route through, so every comment or
 * suggestion used to trigger a full rebuild. The dedupe key only caught *identical*
 * content strings, which an annotation does not produce.
 *
 * Extracted as a pure function so the decision is testable; see
 * `repro-annotation-reload.test.ts` for the guarantee that annotation ops cause zero
 * `setContent` calls.
 */

export interface RenderInputs {
	editorReady: boolean;
	currentPath: string | null;
	/** Local unsaved edits — the stored content must not clobber them. */
	isDirty: boolean;
	isLoading: boolean;
	/** Markdown held by the editor store (drives the effect). */
	content: string;
	/** Markdown actually destined for ProseMirror (e.g. viewing-mode body). */
	renderMarkdown: string;
	/** `${path} ${markdown}` of the last successful render. */
	lastRenderedKey: string | null;
	lastRenderedPath: string | null;
	annotationChanged: boolean;
}

interface RenderDecision {
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
 * The single predicate guarding document re-serialization.
 *
 * Ordering matters: cheap structural guards, then the content comparison, then the
 * annotation-only exemption.
 */
export function shouldRerenderDocument(input: RenderInputs): RenderDecision {
	if (!input.editorReady) return { rerender: false, reason: "no-editor" };
	if (input.currentPath === null) return { rerender: false, reason: "no-path" };
	if (input.isDirty) return { rerender: false, reason: "dirty-local-edit" };

	// During navigation the store briefly holds content="" while the fetch is in
	// flight; rendering that is pure waste (two full schema passes).
	if (input.isLoading && input.content === "") {
		return { rerender: false, reason: "loading-empty" };
	}

	const key = `${input.currentPath} ${input.renderMarkdown}`;
	if (input.lastRenderedKey === key) {
		return { rerender: false, reason: "already-rendered" };
	}

	// Annotation mutations reach ProseMirror as TRANSACTIONS by their own code path.
	// Routing them back through markdownToHtml + setContent is what destroys selection
	// and scroll, so when annotation state is the only thing that changed, stand down.
	if (input.annotationChanged && !contentActuallyChanged(input)) {
		return { rerender: false, reason: "annotation-only" };
	}

	return { rerender: true, reason: "content-changed" };
}

/**
 * True when the markdown destined for ProseMirror differs from what was last rendered.
 * Compares the key's markdown portion only; path changes are handled above.
 */
function contentActuallyChanged(input: RenderInputs): boolean {
	if (input.lastRenderedKey === null) return true;
	const renderedMarkdown = input.lastRenderedKey.slice(
		(input.lastRenderedPath ?? input.currentPath ?? "").length + 1,
	);
	return renderedMarkdown !== input.renderMarkdown;
}