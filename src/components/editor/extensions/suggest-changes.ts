/**
 * Tracked suggestions, backed by the vendored `prosemirror-suggest-changes`.
 *
 * WHY THIS REPLACED THE HAND-WRITTEN TRACK CHANGES
 * ------------------------------------------------
 * The previous implementation intercepted transactions in `filterTransaction`
 * and returned `false` to cancel a delete, then re-added a deletion mark from a
 * later view-update pass. Cancelling meant the document did not change, so the
 * caret never advanced: every Backspace recomputed the range it had already
 * marked and the text appeared to stop deleting after the first press.
 *
 * The library instead REWRITES each transaction into one that adds marks, and
 * applies it. The document is consistent, the selection moves naturally, and
 * there is no queue to drain. It handles every ProseMirror step type -
 * ReplaceStep, ReplaceAroundStep, AddMarkStep, RemoveMarkStep, AddNodeMarkStep,
 * RemoveNodeMarkStep, AttrStep - so splits, joins, mark changes and attribute
 * changes are covered, not only typing and Backspace.
 *
 * The library ships ProseMirror `MarkSpec`s, not Tiptap extensions, so this
 * wraps them.
 *
 * KNOWN LIMIT: BLOCK-LEVEL SUGGESTIONS
 * ------------------------------------
 * The library also expresses whole-block suggestions (inserting a list item,
 * splitting a paragraph) by allowing these marks on the `doc` node. Tiptap owns
 * the `doc` node and does not accept block marks, so that case is not available
 * here. Inline and paragraph-level edits - typing, deleting, formatting - are
 * fully covered, which is what markdown documents need. A block-boundary
 * suggestion will apply directly rather than being tracked; `ponytail:` raising
 * it means a custom `doc` node that extends Tiptap's with `marks`.
 */
import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import {
	addSuggestionMarks,
	transformToSuggestionTransaction,
	suggestChanges,
	suggestChangesKey,
	isSuggestChangesEnabled,
} from "@/vendor/prosemirror-suggest-changes/index.js";

const specs = addSuggestionMarks({});

/** `id` is the suggestion this run belongs to; the library assigns it. */
const idAttr = { id: { default: null } };

function markExtension(
	name: "insertion" | "deletion" | "modification",
	tag: string,
	className: string,
) {
	const spec = specs[name];
	return Mark.create({
		name,
		// The library sets this to keep the three marks mutually exclusive.
		excludes: spec.excludes as string,
		inclusive: false,
		// Higher than StarterKit's `Strike`, which also parses a bare `<del>`.
		priority: 1000,
		addAttributes() {
			return idAttr;
		},
		parseHTML() {
			// The `[data-id]` qualifier is doing real work here, not decoration.
			//
			// StarterKit's Strike extension also parses `tag: "del"`. Without the
			// qualifier both rules match a deletion suggestion, Strike wins the
			// tie, and the mark comes back from a reload as plain strikethrough
			// with its `data-id` stripped - measured: `<del data-id="3">h here</del>`
			// parsed to `<s>h here</s>`. Requiring the attribute means only a
			// suggestion can match this rule; a plain `<del>` still means
			// strikethrough, which is the correct reading of the markdown anyway.
			return [
				{
					tag: `${tag}[data-id]`,
					getAttrs: (el: HTMLElement) => ({ id: el.getAttribute("data-id") }),
				},
			];
		},
		renderHTML({ HTMLAttributes }) {
			return [
				tag,
				mergeAttributes(HTMLAttributes, {
					"data-id": HTMLAttributes.id,
					class: className,
				}),
				0,
			];
		},
	});
}

export const SuggestionInsertion = markExtension("insertion", "ins", "track-insertion");
export const SuggestionDeletion = markExtension("deletion", "del", "track-deletion");
export const SuggestionModification = markExtension("modification", "span", "track-modification");

/**
 * The plugin that tracks whether suggestions are on, plus the transaction
 * rewrite that makes typing and deleting produce suggestions.
 *
 * Tiptap's `dispatchTransaction` hook is the seam: it hands us the incoming
 * transaction and a `next` to dispatch through. When suggestions are enabled we
 * hand `next` a REWRITTEN transaction instead of the original. Rewriting rather
 * than rejecting is the whole point - the rewritten transaction applies
 * normally, so the selection advances and the document stays consistent.
 */
export const SuggestChanges = Extension.create({
	name: "suggestChanges",

	addProseMirrorPlugins() {
		return [suggestChanges()];
	},

	dispatchTransaction({ transaction, next }) {
		const state = this.editor.state;
		// The library's own commands - accept, reject, select - set `skip` on the
		// transaction they dispatch. Rewriting those would re-mark the very edits
		// they are trying to settle: measured before this guard, "Accept all" on a
		// document with 2 suggestions left 6 of them, each accept becoming a fresh
		// deletion/insertion pair around the text it was meant to resolve.
		if (transaction.getMeta(suggestChangesKey)?.skip) {
			next(transaction);
			return;
		}
		if (!isSuggestChangesEnabled(state)) {
			next(transaction);
			return;
		}
		next(transformToSuggestionTransaction(transaction, state));
	},
});