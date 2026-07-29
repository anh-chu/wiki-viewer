import { Mark, mergeAttributes } from "@tiptap/core";

export const ProofSpan = Mark.create({
	name: "proofSpan",
	priority: 900,
	inclusive: false,
	keepOnSplit: false,

	addAttributes() {
		return {
			spanId: {
				default: null,
				parseHTML: (el) => el.getAttribute("id"),
				renderHTML: (a) => ({ id: a.spanId }),
			},
			origin: {
				default: "ai",
				parseHTML: (el) => el.getAttribute("origin"),
				renderHTML: (a) => ({ origin: a.origin }),
			},
			basis: {
				default: null,
				parseHTML: (el) => el.getAttribute("basis"),
				renderHTML: (a) => ({ basis: a.basis }),
			},
			basisDetail: {
				default: null,
				parseHTML: (el) => el.getAttribute("basis-detail"),
				renderHTML: (a) => ({ "basis-detail": a.basisDetail }),
			},
			by: {
				default: null,
				parseHTML: (el) => el.getAttribute("by"),
				renderHTML: (a) => ({ by: a.by }),
			},
			at: {
				default: null,
				parseHTML: (el) => el.getAttribute("at"),
				renderHTML: (a) => ({ at: a.at }),
			},
			inResponseTo: {
				default: null,
				parseHTML: (el) => el.getAttribute("in-response-to"),
				renderHTML: (a) => ({ "in-response-to": a.inResponseTo }),
			},
		};
	},

	parseHTML() {
		return [{ tag: "proof-span" }];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"proof-span",
			mergeAttributes(HTMLAttributes, { class: "proof-span" }),
			0,
		];
	},
});
