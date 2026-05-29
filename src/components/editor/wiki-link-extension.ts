import { InputRule, Mark, mergeAttributes } from "@tiptap/core";
import { wikiLinkDecoratorPlugin } from "./wiki-link-decorator";

// Matches: [[slug]]  [[slug|alias]]  [[slug#anchor]]
// Groups:  1=slug    2=alias         3=anchor
const INPUT_RULE_REGEX = /\[\[([a-z0-9-]+)(?:\|([^\]#|]+)|#([a-z0-9-]+))?\]\]$/;

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		wikiLink: {
			/** Apply a wiki-link mark to the current selection. */
			setWikiLink: (attrs: {
				slug: string;
				alias?: string | null;
				anchor?: string | null;
			}) => ReturnType;
			/** Remove the wiki-link mark from the current selection. */
			unsetWikiLink: () => ReturnType;
		};
	}
}

export const WikiLink = Mark.create({
	name: "wikiLink",
	priority: 1000,
	keepOnSplit: false,
	inclusive: false,

	addAttributes() {
		return {
			slug: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-slug"),
				renderHTML: (attributes) => ({
					"data-slug": attributes.slug,
				}),
			},
			alias: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-alias"),
				renderHTML: (attributes) =>
					attributes.alias != null ? { "data-alias": attributes.alias } : {},
			},
			anchor: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-anchor"),
				renderHTML: (attributes) =>
					attributes.anchor != null ? { "data-anchor": attributes.anchor } : {},
			},
		};
	},

	parseHTML() {
		return [{ tag: 'a[data-wiki-link="true"]' }];
	},

	renderHTML({ HTMLAttributes }) {
		const slug = String(HTMLAttributes["data-slug"] ?? "");
		const anchor =
			HTMLAttributes["data-anchor"] != null
				? String(HTMLAttributes["data-anchor"])
				: null;
		const href = anchor ? `#wiki:${slug}#${anchor}` : `#wiki:${slug}`;
		return [
			"a",
			mergeAttributes(HTMLAttributes, {
				"data-wiki-link": "true",
				href,
				class: "wiki-link",
			}),
			0,
		];
	},

	addInputRules() {
		// markInputRule always uses the last capture group as visible text and
		// cannot produce variable text per form ([[slug]] vs [[slug|alias]] vs
		// [[slug#anchor]]). A raw InputRule is required here.
		return [
			new InputRule({
				find: INPUT_RULE_REGEX,
				handler: ({ state, range, match }) => {
					const slug: string = match[1] ?? "";
					const alias: string | null = match[2] ?? null;
					const anchor: string | null = match[3] ?? null;
					const visibleText = alias ?? (anchor ? `${slug}#${anchor}` : slug);
					const { tr } = state;
					tr.replaceWith(
						range.from,
						range.to,
						state.schema.text(visibleText, [
							this.type.create({ slug, alias, anchor }),
						]),
					);
				},
			}),
		];
	},

	addProseMirrorPlugins() {
		return [wikiLinkDecoratorPlugin()];
	},

	addCommands() {
		return {
			setWikiLink:
				(attrs) =>
				({ commands }) =>
					commands.setMark(this.name, {
						slug: attrs.slug,
						alias: attrs.alias ?? null,
						anchor: attrs.anchor ?? null,
					}),
			unsetWikiLink:
				() =>
				({ commands }) =>
					commands.unsetMark(this.name),
		};
	},
});
