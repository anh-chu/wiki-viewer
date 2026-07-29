import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const WIKI_LINK_DECORATOR_KEY = new PluginKey<DecorationSet>(
	"wikiLinkDecorator",
);

const REFRESH_META = "wikiLinkDecorator:refresh";

export type WikiSlugResolver = { has(slug: string): boolean };

/**
 * Walk the doc, find every wikiLink mark, and emit an inline decoration
 * carrying data-broken="true" for any slug not known to the resolver.
 *
 * Decorations apply attributes during ProseMirror's own DOM render pass,
 * so they don't trigger the MutationObserver feedback loop that direct
 * setAttribute would.
 *
 * When no resolver is supplied, every slug is treated as UNKNOWN (broken).
 */
function buildDecorations(
	state: EditorState,
	resolver?: WikiSlugResolver,
): DecorationSet {
	const markType = state.schema.marks.wikiLink;
	if (!markType) return DecorationSet.empty;

	const decorations: Decoration[] = [];
	state.doc.descendants((node, pos) => {
		if (!node.isText) return;
		const mark = node.marks.find((m) => m.type === markType);
		if (!mark) return;
		const slug = mark.attrs.slug as string | undefined;
		if (!slug) return;
		// When resolver is absent, every slug is unknown → mark as broken.
		// When present, mark only slugs the resolver doesn't know about.
		if (resolver && resolver.has(slug)) return;
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
 * the resolver. Recomputes on doc changes.
 */
export function wikiLinkDecoratorPlugin(
	resolver?: WikiSlugResolver,
): Plugin {
	return new Plugin<DecorationSet>({
		key: WIKI_LINK_DECORATOR_KEY,
		state: {
			init: (_config, state) => buildDecorations(state, resolver),
			apply(tr: Transaction, old: DecorationSet, _oldState, newState) {
				if (tr.getMeta(REFRESH_META)) return buildDecorations(newState, resolver);
				if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
				return buildDecorations(newState, resolver);
			},
		},
		props: {
			decorations(state) {
				return WIKI_LINK_DECORATOR_KEY.getState(state) ?? DecorationSet.empty;
			},
		},
	});
}
