import { mergeAttributes, Node } from "@tiptap/core";

export const CalloutExtension = Node.create({
	name: "callout",
	group: "block",
	content: "block+",
	defining: true,

	addAttributes() {
		return {
			type: {
				default: "info",
				parseHTML: (element: HTMLElement) =>
					element.getAttribute("data-callout-type") || "info",
				renderHTML: (attributes: Record<string, unknown>) => ({
					"data-callout-type": attributes.type,
				}),
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-callout="true"]' }];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-callout": "true",
				class: `callout callout-${HTMLAttributes["data-callout-type"] || "info"}`,
			}),
			0,
		];
	},
});
