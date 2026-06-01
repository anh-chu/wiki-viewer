import { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeOptions } from "rehype-sanitize";

/**
 * Sanitize schema for the read-only markdown preview.
 *
 * The base `defaultSchema` from rehype-sanitize strips most attributes and
 * many elements. Wiki content legitimately embeds raw HTML, primarily tables
 * produced by the TipTap editor (with colgroup/col, colspan/rowspan, inline
 * width styles, and utility classes). Extend the schema so that markup renders
 * instead of being escaped to literal text, while still removing scripts,
 * event handlers, and other dangerous vectors that defaultSchema blocks.
 */
const tableTags = ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col"];

export const previewSanitizeSchema: SanitizeOptions = {
	...defaultSchema,
	tagNames: Array.from(
		new Set([...(defaultSchema.tagNames ?? []), ...tableTags]),
	),
	attributes: {
		...defaultSchema.attributes,
		// Allow layout attributes on table elements.
		table: [...(defaultSchema.attributes?.table ?? []), "className", "style"],
		th: [
			...(defaultSchema.attributes?.th ?? []),
			"colSpan",
			"rowSpan",
			"style",
			"className",
		],
		td: [
			...(defaultSchema.attributes?.td ?? []),
			"colSpan",
			"rowSpan",
			"style",
			"className",
		],
		col: ["span", "style", "className"],
		colgroup: ["span", "style", "className"],
		tr: ["style", "className"],
		// Preserve wiki-link data attributes used by the custom <a> renderer.
		a: [
			...(defaultSchema.attributes?.a ?? []),
			"className",
			["dataWikiLink", "data-wiki-link"],
			["dataSlug", "data-slug"],
			["dataAlias", "data-alias"],
			["dataAnchor", "data-anchor"],
			["dataBroken", "data-broken"],
		],
		// Allow class names on common block/inline elements for styling.
		"*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "id"],
	},
};
