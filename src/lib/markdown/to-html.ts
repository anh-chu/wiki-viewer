import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { detectEmbed } from "@/lib/embeds/detect";

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
 * Rewrite relative URLs (./file.pdf, ./image.png) to /api/assets/{pagePath}/file
 * and convert PDF links to inline embedded viewers.
 * Applies to href, src, and data-src attributes (the last is used by embed blocks).
 */
function resolveRelativeUrls(html: string, pagePath: string): string {
	const dirPath = pagePath;

	html = html.replace(
		/href="\.\/([^"]+)"/g,
		(_match, file: string) => `href="/api/assets/${dirPath}/${file}"`,
	);

	html = html.replace(
		/src="\.\/([^"]+)"/g,
		(_match, file: string) => `src="/api/assets/${dirPath}/${file}"`,
	);

	html = html.replace(
		/data-src="\.\/([^"]+)"/g,
		(_match, file: string) => `data-src="/api/assets/${dirPath}/${file}"`,
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

// Unified's plugin resolution + processor freeze runs on every `unified()`
// call. Reuse a single frozen pipeline across every page render so
// navigation doesn't pay that cost on the hot path.
const processor = unified()
	.use(remarkParse)
	.use(remarkGfm)
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeStringify, { allowDangerousHtml: true })
	.freeze();

export async function markdownToHtml(
	markdown: string,
	pagePath?: string,
): Promise<string> {
	// Pre-process wiki-links before remark (which would treat [[ as text)
	const preprocessed = convertWikiLinks(markdown);

	const result = await processor.process(preprocessed);

	let html = String(result);

	// Post-process task lists for Tiptap compatibility
	html = fixTaskListHtml(html);

	// Heal <video src="youtube-url"> into real iframe embeds
	html = upgradeProviderVideos(html);

	// Resolve relative URLs if page path is provided
	if (pagePath) {
		html = resolveRelativeUrls(html, pagePath);
	}

	return html;
}
