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
		// Embed wrapper divs, and block-level modifications (see `span` below).
		div: [
			...(defaultSchema.attributes?.div ?? []),
			"className",
			["dataEmbed", "true"],
			"dataProvider",
			"dataSrc",
			"dataOriginalUrl",
			"dataAspectRatio",
			"dataId",
			"dataType",
			"dataModType",
			// Which node attribute an attribute modification changes. `commands.js`
			// requires this to be a string before it will restore the old value, so
			// dropping it makes a rejected attribute edit throw `Unknown modification
			// type` after a reload. Verified against the parser: `data-mod-attr-name`
			// becomes `dataModAttrName` in hast.
			"dataModAttrName",
			"dataModPrevVal",
			"dataModNewVal",
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
		// Suggested insertions and deletions carry the id of the suggestion they
		// belong to. rehype-sanitize uses hast property names (camelCase) here, so
		// this is `dataId` for a `data-id` attribute.
		//
		// Without it the sanitizer strips the attribute, and the mark no longer
		// parses: a pending deletion came back from a reload as plain `<s>`
		// strikethrough and an insertion lost its mark, so both suggestions
		// silently applied themselves on the next save.
		ins: [...(defaultSchema.attributes?.ins ?? []), "className", "dataId"],
		del: [...(defaultSchema.attributes?.del ?? []), "className", "dataId"],
		// A modification needs THREE more properties than ins/del, because it
		// serialises what the change was from and to rather than only which
		// suggestion it belongs to. `data-mod-type` selects text vs attribute
		// changes, and for an attribute change `data-mod-prev-val` is the value
		// reject restores - drop it and a rejected attribute edit cannot be undone.
		//
		// `data-type="modification"` is also the parse selector, so losing it
		// un-marks the modification entirely on the next reload. `data` is not
		// listed because sanitize turns `data-type`/`data-mod-*` into
		// `dataType`/`dataMod*`; only `data-type` is spelled out here for that
		// reason and the rest use their camelCase form.
		span: [
			...(defaultSchema.attributes?.span ?? []),
			"className",
			"dataId",
			"dataType",
			"dataModType",
			// Which node attribute an attribute modification changes. `commands.js`
			// requires this to be a string before it will restore the old value, so
			// dropping it makes a rejected attribute edit throw `Unknown modification
			// type` after a reload. The hast name was verified against the parser.
			"dataModAttrName",
			"dataModPrevVal",
			"dataModNewVal",
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
