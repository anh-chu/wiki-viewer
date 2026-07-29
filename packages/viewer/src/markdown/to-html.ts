import rehypeParse from "rehype-parse";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { detectEmbed } from "./embeds-detect";
import { previewSanitizeSchema } from "./sanitize-schema";

// Canonical wiki-link regex (llm-wiki-pm ground truth).
// Groups: 1=slug  2=alias  3=anchor
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:\|([^\]]*)|#([^\]]*))?\]\]/g;
const SLUG_VALID_RE = /^[a-z0-9-]+$/;

/**
 * Pre-process markdown to convert wiki-links to HTML anchors
 * before the remark pipeline (which treats [[ as plain text).
 *
 * Handles three forms:
 *   [[slug]]          - bare
 *   [[slug|alias]]    - aliased
 *   [[slug#anchor]]   - anchored
 *
 * Slugs that fail ^[a-z0-9-]+$ validation are left as plain text.
 */
function convertWikiLinks(markdown: string): string {
	return markdown.replace(
		WIKI_LINK_RE,
		(
			_match: string,
			rawSlug: string,
			alias: string | undefined,
			anchor: string | undefined,
		): string => {
			const slug = rawSlug.trim();
			if (!SLUG_VALID_RE.test(slug)) return _match;
			const visibleText = alias ?? (anchor ? `${slug}#${anchor}` : slug);
			const href = anchor ? `#wiki:${slug}#${anchor}` : `#wiki:${slug}`;
			const aliasAttr = alias !== undefined ? ` data-alias="${alias}"` : "";
			const anchorAttr = anchor !== undefined ? ` data-anchor="${anchor}"` : "";
			return `<a data-wiki-link="true" data-slug="${slug}"${aliasAttr}${anchorAttr} href="${href}" class="wiki-link">${visibleText}</a>`;
		},
	);
}

/**
 * Post-process HTML to fix task list structure for Tiptap compatibility.
 * remark-gfm outputs: <li><input type="checkbox" ...> text</li>
 * Tiptap expects:     <li data-type="taskItem" data-checked="..."><label><input ...></label><div><p>text</p></div></li>
 * And the parent <ul> needs class="task-list" and data-type="taskList".
 */
function fixTaskListHtml(html: string): string {
	// Convert task list <ul> with contains-task-list class
	html = html.replace(
		/<ul class="contains-task-list">/g,
		'<ul data-type="taskList" class="task-list">',
	);

	// Convert each task list item to Tiptap's expected structure
	html = html.replace(
		/<li class="task-list-item">\s*<input type="checkbox"([^>]*)>\s*([\s\S]*?)(?=<\/li>)/g,
		(_match, attrs: string, content: string) => {
			const checked = attrs.includes("checked");
			const cleanContent = content.trim();
			return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${checked ? " checked" : ""}></label><div><p>${cleanContent}</p></div>`;
		},
	);

	return html;
}

/**
 * Upgrade broken `<video src="https://youtu.be/...">` (or any non-file video URL
 * that points at a known embed provider) into a real iframe embed block.
 *
 * This heals content written before we had proper embed support, and also any
 * time the TipTap schema round-trip collapsed an iframe into a video tag.
 */
function upgradeProviderVideos(html: string): string {
	return html.replace(
		/<video\b([^>]*)\bsrc="([^"]+)"([^>]*)><\/video>/gi,
		(match, _before: string, src: string, _after: string) => {
			const detected = detectEmbed(src);
			if (!detected || detected.provider === "video") return match;

			const aspect = detected.aspectRatio
				? ` data-aspect-ratio="${detected.aspectRatio}"`
				: "";
			return (
				`<div data-embed="true" data-provider="${detected.provider}"` +
				` data-src="${detected.embedUrl}"` +
				` data-original-url="${detected.originalUrl}"${aspect}>` +
				`<iframe src="${detected.embedUrl}"` +
				` data-embed-provider="${detected.provider}"` +
				` allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"` +
				` allowfullscreen loading="lazy" frameborder="0"></iframe>` +
				`</div>`
			);
		},
	);
}

/**
 * Rewrite relative URLs (./file.pdf, ../image.png) to /api/assets/{dir}/file
 * where {dir} is the page's directory (dirname of pagePath), and convert PDF
 * links to inline embedded viewers.
 * Applies to href, src, and data-src attributes (the last is used by embed blocks).
 */
function resolveRelativeUrls(html: string, pagePath: string): string {
	// Base directory is the page's parent dir, not the page file itself.
	const slash = pagePath.lastIndexOf("/");
	const dirPath = slash === -1 ? "" : pagePath.slice(0, slash);

	const toAbs = (file: string): string => {
		const parts = (dirPath ? dirPath.split("/") : []).concat(file.split("/"));
		const out: string[] = [];
		for (const seg of parts) {
			if (seg === "" || seg === ".") continue;
			if (seg === "..") out.pop();
			else out.push(seg);
		}
		return `/api/assets/${out.join("/")}`;
	};

	html = html.replace(
		/href="(\.\.?\/[^"]+)"/g,
		(_match, file: string) => `href="${toAbs(file)}"`,
	);

	html = html.replace(
		/src="(\.\.?\/[^"]+)"/g,
		(_match, file: string) => `src="${toAbs(file)}"`,
	);

	html = html.replace(
		/data-src="(\.\.?\/[^"]+)"/g,
		(_match, file: string) => `data-src="${toAbs(file)}"`,
	);

	// Mark PDF links with a data attribute so the editor can handle them
	html = html.replace(
		/<a([^>]*?)href="(\/api\/assets\/[^"]+\.pdf)"([^>]*?)>/gi,
		(_match, before: string, url: string, after: string) => {
			return `<a${before}href="${url}"${after} data-pdf-link="true">`;
		},
	);

	return html;
}

export interface MarkdownRenderOptions {
	/** File path used to resolve relative URLs (./image.png etc.). */
	docPath?: string;
	/**
	 * Optional transform applied to every /api/assets/... URL in src, href,
	 * and data-src attributes. When absent, URLs are left unchanged (identity).
	 * The app uses this to inject workspace-scoping (?ws=... or ?root=...).
	 */
	assetUrlTransform?: (url: string) => string;
	/**
	 * Run rehype-sanitize over the output. DEFAULTS TO TRUE.
	 *
	 * Passing false is UNSAFE for untrusted files. The pipeline uses rehype-raw,
	 * so raw HTML embedded in a markdown file is expanded: with sanitizing off,
	 * <script>, onerror= and javascript: hrefs all survive into the host's
	 * origin. Only pass false for content you control.
	 */
	sanitize?: boolean;
}

// Internal options (extends public options with sanitize flag used by cache key).
interface MarkdownToHtmlOptions {
	pagePath?: string;
	sanitize?: boolean;
	assetUrlTransform?: (url: string) => string;
}

function toInternalOpts(
	optsOrPagePath?: string | MarkdownRenderOptions,
): MarkdownToHtmlOptions {
	if (typeof optsOrPagePath === "string") {
		return { pagePath: optsOrPagePath, sanitize: true };
	}
	if (!optsOrPagePath) return { sanitize: true };
	return {
		pagePath: optsOrPagePath.docPath,
		// Safe by default: a caller has to ask for the dangerous mode by name.
		sanitize: optsOrPagePath.sanitize ?? true,
		assetUrlTransform: optsOrPagePath.assetUrlTransform,
	};
}

// Unified's plugin resolution + processor freeze runs on every `unified()`
// call. Reuse single frozen pipelines across every page render so
// navigation doesn't pay that cost on the hot path.

// Base pipeline: produces HTML with raw nodes passed through as-is.
// Used for both editor and (pre-sanitize) viewer passes.
const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeStringify, { allowDangerousHtml: true })
	.freeze();

// Sanitize-only pipeline: takes a fully assembled HTML string, parses it back
// into hast (rehype-parse as a fragment), expands any raw nodes (rehype-raw),
// then strips unsafe nodes (rehype-sanitize). Runs LAST so all string
// post-processing is covered by sanitize.

/**
 * Remove elements that only survived sanitizing as debris.
 *
 * iframe: the schema restricts src to the embed providers this pipeline emits,
 * but a filtered attribute leaves the ELEMENT behind, and <iframe> with no src
 * loads about:blank, which is same-origin with the host document. Nothing can
 * script it today, since every script path is stripped, but a same-origin frame
 * planted by an untrusted file is a latent surface, and it paints an empty box.
 *
 * input: hast-util-sanitize's defaultSchema carries required.input =
 * { type: "checkbox", disabled: true }, so a hostile <input name="pw"> is not
 * dropped, it is COERCED into a disabled checkbox. Harmless, it cannot submit
 * anywhere, but a password field turning into a stray checkbox in the middle of a
 * document is visible debris. Inputs are only legitimate here as task-list
 * checkboxes, so anything outside a task item goes.
 */
function dropSanitizerDebris() {
	return (tree: unknown): void => {
		type Node = {
			type?: string;
			tagName?: string;
			properties?: { src?: unknown; dataType?: unknown };
			children?: unknown[];
		};
		const walk = (node: Node, inTaskItem: boolean): void => {
			if (!Array.isArray(node.children)) return;
			node.children = node.children.filter((child) => {
				const el = child as Node;
				if (el.type !== "element") return true;
				if (el.tagName === "iframe") {
					return typeof el.properties?.src === "string" && el.properties.src.length > 0;
				}
				if (el.tagName === "input") return inTaskItem;
				return true;
			});
			for (const child of node.children) {
				const el = child as Node;
				const isTaskItem = el.tagName === "li" && el.properties?.dataType === "taskItem";
				walk(el, inTaskItem || isTaskItem);
			}
		};
		walk(tree as Node, false);
	};
}

const sanitizerOnly = unified()
	.use(rehypeParse, { fragment: true })
	.use(rehypeRaw)
	.use(rehypeSanitize, previewSanitizeSchema)
	.use(dropSanitizerDebris)
	.use(rehypeStringify)
	.freeze();

// Render cache: the remark→rehype pipeline is the heaviest synchronous work on
// the open path. Keying rendered HTML by (content, options) makes re-opening a
// doc — or returning to it — parse-free. Bounded LRU so it can't grow unbounded.
const RENDER_CACHE_MAX = 50;
// Skip caching very large outputs to bound memory (still parsed, just not retained).
const RENDER_CACHE_MAX_HTML = 256 * 1024;
const renderCache = new Map<string, string>();

/** Cheap, stable 53-bit string hash (cyrb53) — no crypto, no allocations per char. */
function hashStr(s: string): string {
	let h1 = 0xdeadbeef ^ s.length;
	let h2 = 0x41c6ce57 ^ s.length;
	for (let i = 0; i < s.length; i++) {
		const ch = s.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Stable cache key for a (markdown, options) render. Shared by sync + worker paths. */
export function renderCacheKeyFor(
	markdown: string,
	optsOrPagePath?: string | MarkdownRenderOptions,
): string {
	const opts = toInternalOpts(optsOrPagePath);
	return `${opts.sanitize ? 1 : 0}:${opts.pagePath ?? ""}:${markdown.length}:${hashStr(markdown)}`;
}

/** Look up a previously rendered result (LRU-refreshed). */
export function renderCacheGet(key: string): string | undefined {
	const cached = renderCache.get(key);
	if (cached === undefined) return undefined;
	renderCache.delete(key);
	renderCache.set(key, cached);
	return cached;
}

/** Store a rendered result, evicting the oldest entry past the cap. */
export function renderCacheStore(key: string, html: string): void {
	if (html.length > RENDER_CACHE_MAX_HTML) return;
	renderCache.set(key, html);
	if (renderCache.size > RENDER_CACHE_MAX) {
		const oldest = renderCache.keys().next().value;
		if (oldest !== undefined) renderCache.delete(oldest);
	}
}

/**
 * Pure markdown→HTML transform with NO cache. Safe to run in a Web Worker
 * (string-only post-processing, no DOM). The cache lives on the main thread so
 * cache hits never pay a worker round-trip.
 */
export async function renderMarkdownUncached(
	markdown: string,
	optsOrPagePath?: string | MarkdownRenderOptions | MarkdownToHtmlOptions,
): Promise<string> {
	// Accepts either the public shape (docPath) or the internal one (pagePath).
	let opts: MarkdownToHtmlOptions;
	if (typeof optsOrPagePath === "string" || !optsOrPagePath) {
		opts = toInternalOpts(optsOrPagePath);
	} else {
		const raw = optsOrPagePath as MarkdownRenderOptions & MarkdownToHtmlOptions;
		opts = {
			pagePath: raw.docPath ?? raw.pagePath,
			sanitize: raw.sanitize ?? true,
			assetUrlTransform: raw.assetUrlTransform,
		};
	}

	// Pre-process wiki-links before remark (which would treat [[ as text)
	const preprocessed = convertWikiLinks(markdown);

	// Always use the base pipeline first.
	const result = await processor.process(preprocessed);
	let html = String(result);

	// Post-process task lists for Tiptap compatibility.
	html = fixTaskListHtml(html);

	// Heal <video src="youtube-url"> into real iframe embeds.
	// Must run before sanitize so <video src> attr is still present.
	html = upgradeProviderVideos(html);

	// Resolve relative URLs if page path is provided.
	// Must run before sanitize so interpolated paths are covered.
	if (opts.pagePath) {
		html = resolveRelativeUrls(html, opts.pagePath);
	}

	// Apply asset URL transform to every /api/assets URL so the consumer can
	// inject workspace-scoping (was: withWs from workspace-client). When no
	// transform is provided, URLs are left unchanged (identity).
	const transform = opts.assetUrlTransform;
	if (transform) {
		html = html.replace(
			/(src|href|data-src)="(\/api\/assets\/[^"]*)"/g,
			(_m, attr: string, url: string) => `${attr}="${transform(url)}"`,
		);
	}

	// Sanitize last, after all string post-processing, so no injected
	// content escapes the sanitizer.
	if (opts.sanitize) {
		html = String(await sanitizerOnly.process(html));
	}

	return html;
}

export async function markdownToHtml(
	markdown: string,
	optsOrPagePath?: string | MarkdownRenderOptions,
): Promise<string> {
	const opts = toInternalOpts(optsOrPagePath);

	// Parse-free fast path: identical (content, options) was rendered before.
	const cacheKey = renderCacheKeyFor(markdown, optsOrPagePath);
	const cached = renderCacheGet(cacheKey);
	if (cached !== undefined) return cached;

	const html = await renderMarkdownUncached(markdown, opts);
	renderCacheStore(cacheKey, html);
	return html;
}

/**
 * Primary entry point for the viewer package.
 * Renders markdown to the exact HTML the wiki-viewer app renders, with the
 * asset URL transform injected by the consumer. Sanitizing is opt-in.
 */
export async function renderMarkdownToHtml(
	markdown: string,
	options?: MarkdownRenderOptions,
): Promise<string> {
	return markdownToHtml(markdown, options);
}

/** Alias matching the name used by index.ts re-export. */
export type RenderMarkdownOptions = MarkdownRenderOptions;
