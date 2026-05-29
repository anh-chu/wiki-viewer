import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useWikiSlugsStore } from "@/stores/wiki-slugs-store";

const WIKI_LINK_DECORATOR_KEY = new PluginKey<DecorationSet>(
	"wikiLinkDecorator",
);

const REFRESH_META = "wikiLinkDecorator:refresh";

/**
 * Walk the doc, find every wikiLink mark, and emit an inline decoration
 * carrying data-broken="true" for any slug not in the slug index store.
 *
 * Decorations apply attributes during ProseMirror's own DOM render pass,
 * so they don't trigger the MutationObserver feedback loop that direct
 * setAttribute would.
 */
function buildDecorations(state: EditorState): DecorationSet {
	const { has } = useWikiSlugsStore.getState();
	const markType = state.schema.marks.wikiLink;
	if (!markType) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	state.doc.descendants((node, pos) => {
		if (!node.isText) return;
		const mark = node.marks.find((m) => m.type === markType);
		if (!mark) return;
		const slug = mark.attrs.slug as string | undefined;
		if (!slug || has(slug)) return;
		decorations.push(
			Decoration.inline(pos, pos + node.nodeSize, {
				"data-broken": "true",
			}),
		);
	});

	return DecorationSet.create(state.doc, decorations);
}

/**
 * Plugin that marks wiki-links as broken when their slug is absent from
 * the slug index. Recomputes on doc changes and when the slug store
 * signals a refresh via a meta-only transaction.
 */
export function wikiLinkDecoratorPlugin(): Plugin {
	return new Plugin<DecorationSet>({
		key: WIKI_LINK_DECORATOR_KEY,
		state: {
			init: (_config, state) => buildDecorations(state),
			apply(tr: Transaction, old: DecorationSet, _oldState, newState) {
				if (tr.getMeta(REFRESH_META)) return buildDecorations(newState);
				if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
				return buildDecorations(newState);
			},
		},
		props: {
			decorations(state) {
				return WIKI_LINK_DECORATOR_KEY.getState(state) ?? DecorationSet.empty;
			},
		},
		view(editorView) {
			// Subscribe to slug-store changes. When the index loads or
			// invalidates, dispatch a meta-only transaction so the plugin
			// state recomputes against the latest snapshot.
			const unsubscribe = useWikiSlugsStore.subscribe(() => {
				const tr = editorView.state.tr.setMeta(REFRESH_META, true);
				editorView.dispatch(tr);
			});

			return {
				destroy() {
					unsubscribe();
				},
			};
		},
	});
}
