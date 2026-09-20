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
	withSuggestChanges,
	suggestChanges,
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

/**
 * The modification mark, which needs its own wrapper because it carries state the
 * other two do not.
 *
 * The vendored spec declares FIVE attributes (`id`, `type`, `attrName`,
 * `previousValue`, `newValue`) and serialises four of them — `data-type`,
 * `data-mod-type`, `data-mod-prev-val`, `data-mod-new-val` — with `<span>` inline
 * and `<div>` at block level. The generic wrapper above keeps only `id`, so:
 *
 *   - `attrName` was lost, and it is load-bearing rather than decorative:
 *     `commands.js` reads `mod.attrs["attrName"]` to know which node attribute to
 *     restore when a modification is rejected. Without it a rejected attribute
 *     change cannot be undone.
 *   - `previousValue` / `newValue` were lost, so a reload could not tell what the
 *     change was from or to.
 *   - parse and render disagreed on the element: parse accepts both
 *     `span[data-type='modification']` and `div[data-type='modification']`, render
 *     always emitted `<span>`.
 *
 * Shipping the mark without these made accept/reject work in the session that
 * created the change and silently lose information across a reload.
 */
export const SuggestionModification = Mark.create({
	name: "modification",
	excludes: specs.modification.excludes as string,
	inclusive: false,
	priority: 1000,
	addAttributes() {
		return {
			id: { default: null },
			type: { default: "text" },
			attrName: { default: null },
			previousValue: { default: null },
			newValue: { default: null },
		};
	},
	parseHTML() {
		// Both node forms, matching the vendored spec. A modification can wrap an
		// inline range or a whole block, and Turndown serialises each differently.
		return [
			{
				tag: "span[data-type='modification'][data-id]",
				getAttrs: (el: HTMLElement) => ({
					id: el.getAttribute("data-id"),
					type: el.getAttribute("data-mod-type") ?? "text",
					previousValue: el.getAttribute("data-mod-prev-val"),
					newValue: el.getAttribute("data-mod-new-val"),
				}),
			},
			{
				tag: "div[data-type='modification'][data-id]",
				getAttrs: (el: HTMLElement) => ({
					id: el.getAttribute("data-id"),
					type: el.getAttribute("data-mod-type") ?? "text",
					previousValue: el.getAttribute("data-mod-prev-val"),
				}),
			},
		];
	},
	renderHTML({ HTMLAttributes, mark }) {
		// Inline spans, block divs — the vendored rule, kept rather than flattened
		// to one form, because a block-level modification must not be wrapped in an
		// inline element.
		const inline = typeof mark.attrs.inline === "boolean" ? mark.attrs.inline : true;
		return [
			inline ? "span" : "div",
			mergeAttributes(HTMLAttributes, {
				"data-type": "modification",
				"data-id": HTMLAttributes.id,
				"data-mod-type": mark.attrs.type,
				"data-mod-prev-val": mark.attrs.previousValue,
				"data-mod-new-val": mark.attrs.newValue,
				class: "track-modification",
			}),
			0,
		];
	},
});

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
		// Route through the library's OWN dispatch decorator rather than calling the
		// raw rewriter. The raw path only knew about `skip`, so it rewrote every
		// other transaction it was handed - including undo/redo and any collab or
		// y-sync traffic. `withSuggestChanges` is the guard the library ships for
		// exactly this, and it declines all of:
		//
		//   - `skip` on suggestChangesKey  (its own accept/reject/select commands)
		//   - `history$`                   (prosemirror-history undo/redo)
		//   - `collab$`                    (prosemirror-collab rebase)
		//   - y-sync undo/redo + change-origin
		//
		// Rewriting an undo as a suggestion is the bad case: the user's undo would
		// come back as a new tracked deletion instead of reverting the last one.
		// The `skip` guard alone was measured to matter - before it, "Accept all" on
		// a document with 2 suggestions left 6, each accept re-marking the edit it
		// was meant to settle.
		const guarded = withSuggestChanges((tr) => next(tr));
		guarded.call(this.editor.view, transaction);
	},
});