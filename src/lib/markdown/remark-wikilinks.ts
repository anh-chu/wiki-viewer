import type { Link, Parent, PhrasingContent, Root, Text } from "mdast";
import type { Plugin } from "unified";

const WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|([^\]#|]+)|#([a-z0-9-]+))?\]\]/g;

/**
 * Remark plugin that converts [[slug]], [[slug|alias]], and [[slug#anchor]]
 * occurrences in text nodes into link nodes targeting `#wiki:slug` (with
 * `#anchor` appended when present). The link's data attributes carry the
 * slug, optional alias, and optional anchor so renderers can branch on
 * wiki-links specifically.
 */
const remarkWikilinks: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, (node, index, parent) => {
			if (!parent || index === undefined) return;
			if (node.type !== "text") return;
			const text = (node as Text).value;
			if (!text?.includes("[[")) return;

			const replacements: PhrasingContent[] = [];
			let lastIndex = 0;
			WIKILINK_RE.lastIndex = 0;
			let match: RegExpExecArray | null = WIKILINK_RE.exec(text);
			while (match !== null) {
				const [full, slug, alias, anchor] = match;
				if (match.index > lastIndex) {
					replacements.push({
						type: "text",
						value: text.slice(lastIndex, match.index),
					} as Text);
				}
				const visible = alias ?? (anchor ? `${slug}#${anchor}` : slug);
				const url = anchor ? `#wiki:${slug}#${anchor}` : `#wiki:${slug}`;
				const link: Link = {
					type: "link",
					url,
					title: null,
					children: [{ type: "text", value: visible } as Text],
					data: {
						hProperties: {
							"data-wiki-link": "true",
							"data-slug": slug,
							...(alias ? { "data-alias": alias } : {}),
							...(anchor ? { "data-anchor": anchor } : {}),
							className: ["wiki-link"],
						},
					},
				};
				replacements.push(link);
				lastIndex = match.index + full.length;
				match = WIKILINK_RE.exec(text);
			}

			if (replacements.length === 0) return;
			if (lastIndex < text.length) {
				replacements.push({
					type: "text",
					value: text.slice(lastIndex),
				} as Text);
			}

			(parent as Parent).children.splice(index, 1, ...replacements);
			return index + replacements.length;
		});
	};
};

type Visitor = (
	node: Root | PhrasingContent | Parent,
	index: number | undefined,
	parent: Parent | null,
) => number | undefined;

function visit(
	node: Root | Parent,
	fn: Visitor,
	parent: Parent | null = null,
): void {
	if ("children" in node && Array.isArray(node.children)) {
		let i = 0;
		while (i < node.children.length) {
			const child = node.children[i];
			const next = fn(child as PhrasingContent, i, node);
			if (typeof next === "number") {
				i = next;
				continue;
			}
			if (child && typeof child === "object" && "children" in child) {
				visit(child as Parent, fn, node);
			}
			i += 1;
		}
	}
	if (parent === null) {
		fn(node, undefined, null);
	}
}

export default remarkWikilinks;
