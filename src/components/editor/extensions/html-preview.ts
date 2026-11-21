import { mergeAttributes, Node } from "@tiptap/core";

/**
 * Live HTML from a ```html preview fence. Drawn in a sandboxed frame without
 * same-origin, so its scripts run but cannot reach the page around them.
 * The source is kept on the node and written back as the same fence.
 */
export const HtmlPreview = Node.create({
	name: "htmlPreview",
	group: "block",
	atom: true,
	selectable: true,
	draggable: false,

	addAttributes() {
		return {
			srcdoc: {
				default: "",
				parseHTML: (element: HTMLElement) => element.getAttribute("data-srcdoc") ?? "",
				renderHTML: (attributes: Record<string, unknown>) => ({
					"data-srcdoc": attributes.srcdoc,
				}),
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-html-preview="true"]' }];
	},

	renderHTML({ node, HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, { "data-html-preview": "true", class: "html-preview-block" }),
			[
				"iframe",
				{
					class: "html-preview",
					sandbox: "allow-scripts",
					srcdoc: String(node.attrs.srcdoc ?? ""),
					loading: "lazy",
				},
			],
		];
	},
});
