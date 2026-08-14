import { defaultSchema } from "rehype-sanitize";
import type { Options as SanitizeOptions } from "rehype-sanitize";

/**
 * Sanitize schema for the read-only markdown preview.
 *
 * The base `defaultSchema` from rehype-sanitize strips most attributes and
 * many elements. Wiki content legitimately embeds raw HTML: tables, task-list
 * checkboxes, and video/embed iframes produced by the shared pipeline.
 * Extend the schema so that markup renders instead of being escaped to literal
 * text, while still removing scripts, event handlers, and other dangerous
 * vectors that defaultSchema blocks.
 */
const tableTags = ["table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col"];

export const previewSanitizeSchema: SanitizeOptions = {
	...defaultSchema,
	// Do not prefix `id` with `user-content-`. Proof-span ids are agent-minted
	// (`p####`) and are read back from the rendered DOM by the review UI
	// (run-review-bar, proof-span-popover) to accept/revert a specific span; a
	// clobber prefix would make view-mode ids (`user-content-p1961`) fail to match
	// the file's span id. Content here is single-user trusted, not untrusted web
	// input, so id clobbering is unnecessary. Keep aria clobbering.
	clobber: ["ariaDescribedBy", "ariaLabelledBy"],
	tagNames: Array.from(
		new Set([
			...(defaultSchema.tagNames ?? []),
			...tableTags,
			// Task-list structure emitted by fixTaskListHtml.
			"label",
			// Embed wrapper divs and iframes from upgradeProviderVideos.
			"iframe",
			"video",
			// Inert AI provenance wrapper used by the editor review flow.
			"proof-span",
		]),
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
		// Preserve wiki-link data attributes used by the delegated click handler.
		// rehype-sanitize uses hast property names (camelCase) in the attributes map.
		// Plain string = allow any value; tuple [name, val1, val2] = allow only those values.
		a: [
			...(defaultSchema.attributes?.a ?? []),
			"className",
			["dataWikiLink", "true"],
			"dataSlug",
			"dataAlias",
			"dataAnchor",
			["dataBroken", "true"],
			["dataPdfLink", "true"],
		],
		// Proof-span metadata is inert provenance, not executable HTML.
		// Hyphenated custom attributes stay hyphenated here: rehype-sanitize
		// matches these raw HAST property names for custom elements.
		"proof-span": [
			"id",
			"origin",
			"basis",
			"basis-detail",
			"by",
			"at",
			"in-response-to",
			"className",
		],
		// Task-list input/label.
		input: ["type", "checked", "disabled"],
		label: ["className"],
		// Embed iframes - allow all attrs used by upgradeProviderVideos.
		iframe: [
			"src",
			"allow",
			"allowFullScreen",
			"frameBorder",
			"loading",
			"referrerPolicy",
			"dataEmbedProvider",
		],
		// Embed wrapper divs.
		div: [
			...(defaultSchema.attributes?.div ?? []),
			"className",
			["dataEmbed", "true"],
			"dataProvider",
			"dataSrc",
			"dataOriginalUrl",
			"dataAspectRatio",
		],
		// Task-list list items.
		li: [
			...(defaultSchema.attributes?.li ?? []),
			"className",
			"dataType",
			"dataChecked",
		],
		ul: [
			...(defaultSchema.attributes?.ul ?? []),
			"className",
			"dataType",
		],
		// Allow class names + id on all elements for styling.
		"*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "id"],
	},
	// Allow https iframe src (for embed providers). http excluded intentionally.
	protocols: {
		...defaultSchema.protocols,
		src: [...(defaultSchema.protocols?.src ?? []), "https"],
	},
};
