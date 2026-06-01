import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import type { Root, RootContent } from "mdast";
import type { BlockType } from "./types";

const PARSER = unified().use(remarkParse).use(remarkGfm);
const STRINGIFY = unified()
	.use(remarkStringify, {
		bullet: "-",
		fence: "`",
		fences: true,
		listItemIndent: "one",
		rule: "-",
		emphasis: "*",
		strong: "*",
	})
	.use(remarkGfm);

export function parseBlocks(markdown: string): RootContent[] {
	const tree = PARSER.parse(markdown) as Root;
	return tree.children;
}

export function blockToMarkdown(node: RootContent): string {
	const tree: Root = { type: "root", children: [node] };
	return (STRINGIFY.stringify(tree) as string).replace(/\n+$/, "");
}

export function blocksToMarkdown(nodes: RootContent[]): string {
	if (nodes.length === 0) return "";
	const tree: Root = { type: "root", children: nodes };
	return (STRINGIFY.stringify(tree) as string).replace(/\n+$/, "") + "\n";
}

export function blockType(node: RootContent): {
	type: BlockType;
	level?: number;
	lang?: string;
} {
	switch (node.type) {
		case "heading":
			return { type: "heading", level: (node as unknown as { depth: number }).depth };
		case "paragraph":
			return { type: "paragraph" };
		case "list": {
			const n = node as unknown as { ordered: boolean; children: Array<{ checked: boolean | null | undefined }> };
			if (
				n.children?.some(
					(li) => li.checked !== null && li.checked !== undefined,
				)
			)
				return { type: "taskList" };
			return { type: n.ordered ? "orderedList" : "bulletList" };
		}
		case "blockquote":
			return { type: "blockquote" };
		case "code":
			return {
				type: "codeBlock",
				lang: (node as unknown as { lang: string | null }).lang ?? undefined,
			};
		case "table":
			return { type: "table" };
		case "thematicBreak":
			return { type: "hr" };
		case "html":
			return { type: "html" };
		default:
			return { type: "paragraph" }; // fallback
	}
}
