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
		// Layout attributes on table elements. NOTE: "style" is deliberately absent.
		// A sanitizer cannot inspect inline CSS, so an allowed style attribute lets
		// an untrusted file do position:fixed;inset:0;z-index:9999 and paint a
		// convincing fake UI over the host. In a host where the user types into
		// terminals, a fake prompt is a real attack, not a cosmetic annoyance.
		// Measured cost of dropping it: 2 documents in a 200-document corpus lose
		// a min-width hint.
		table: [...(defaultSchema.attributes?.table ?? []), "className"],
		th: [...(defaultSchema.attributes?.th ?? []), "colSpan", "rowSpan", "className"],
		td: [...(defaultSchema.attributes?.td ?? []), "colSpan", "rowSpan", "className"],
		col: ["span", "className"],
		colgroup: ["span", "className"],
		tr: ["className"],
		// Preserve wiki-link data attributes used by the delegated click handler.
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
		// Embed iframes. src is restricted to the providers this pipeline itself
		// generates. A bare "src" allowance let an untrusted markdown file frame
		// ANY https origin inside the host's page, which is a clickjacking and
		// phishing surface even though the frame cannot reach the host's origin.
		iframe: [
			[
				"src",
				/^https:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\//,
				/^https:\/\/player\.vimeo\.com\//,
				/^https:\/\/(?:www\.)?loom\.com\//,
				/^https:\/\/(?:www\.)?instagram\.com\//,
				/^https:\/\/(?:www\.)?tiktok\.com\//,
				/^https:\/\/open\.spotify\.com\//,
				/^https:\/\/(?:www\.)?facebook\.com\//,
				/^https:\/\/(?:twitter\.com|x\.com)\//,
			],
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

/**
 * hast-util-sanitize honours the className definition it finds in the allow
 * list, and defaultSchema PINS className to single values on several tags:
 *   a:    ["className", "data-footnote-backref"]
 *   ul:   ["className", "contains-task-list"]
 *   code: ["className", /^language-./]
 * Spreading those defaults and then appending a bare "className" does NOT allow
 * our own class names. The tuple wins and the attribute is emptied, which is
 * exactly why sanitized output used to render class="" and lose the wiki-link
 * and task-list styling. Merge our values INTO the existing tuples instead.
 */
const VIEWER_CLASS_NAMES = [
	"wiki-link",
	"task-list",
	"task-list-item",
	"contains-task-list",
];

type AttributeMap = NonNullable<SanitizeOptions["attributes"]>;
type PropertyDef = AttributeMap[string][number];
type PropertyTuple = Extract<PropertyDef, readonly unknown[]>;

for (const [tag, attrs] of Object.entries(previewSanitizeSchema.attributes ?? {})) {
	const list = attrs as PropertyDef[];
	const isClassTuple = (a: PropertyDef) => Array.isArray(a) && a[0] === "className";
	const pinnedValues = list.flatMap((a) =>
		isClassTuple(a) ? (a as PropertyTuple).slice(1) : [],
	);
	const hadBareClassName = list.includes("className");
	const rest = list.filter((a) => a !== "className" && !isClassTuple(a));

	// className is ALWAYS reduced to an explicit allowlist, never left bare.
	// A bare className would let an untrusted file borrow the host's own utility
	// classes: a real document in our corpus already styles tables with
	// "border-collapse w-full", which proves host classes take effect, so
	// "fixed inset-0 z-50" would too. hadBareClassName is tracked only to show
	// intent in the diff; it no longer widens what is permitted.
	void hadBareClassName;
	const merged: PropertyTuple = [
		"className",
		...pinnedValues,
		...VIEWER_CLASS_NAMES,
	] as PropertyTuple;

	previewSanitizeSchema.attributes![tag] = [...rest, merged];
}

