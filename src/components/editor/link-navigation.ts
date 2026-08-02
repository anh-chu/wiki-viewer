// Pure helper for resolving internal Markdown/wiki links without depending on
// a global tree model. It normalizes .md/.markdown extensions, ./ and root
// prefixes, current-directory-relative paths, and delegates bare wiki slugs to
// the slug index. Callers are responsible for loading the returned path (e.g.
// useEditorStore.loadPage) and scrolling to any #hash fragment.

import type { WikiSlugDir } from "@/stores/wiki-slugs-store";

export interface WikiSlugResolver {
	has(slug: string): boolean;
	getDir(slug: string): WikiSlugDir | null;
}

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i;

function decodeSegment(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function normalizePath(input: string): string | null {
	const parts = input.split("/").filter((p) => p.length > 0 && p !== ".");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "..") {
			if (stack.length === 0) return null;
			stack.pop();
		} else {
			stack.push(part);
		}
	}
	return stack.join("/");
}

function hasExtension(segment: string): boolean {
	return /\.[^./]+$/.test(segment);
}

function ensureMarkdownExtension(path: string, wasMarkdown: boolean): string {
	const last = path.split("/").pop() ?? path;
	if (hasExtension(last)) return path;
	return `${path}.md`;
}

/**
 * Resolve an internal link href to a workspace-root-relative path.
 *
 * Returns `null` for non-internal targets (external URLs, mailto, /api/,
 * anchor-only links, or paths that escape the workspace root).
 *
 * The resolver is consulted only for bare wiki slugs (no path separators and
 * no explicit extension). Deterministic paths are produced even when the
 * target file does not yet exist; the caller's loadPage handles missing files.
 */
export function resolveWikiLink(
	href: string,
	currentPath: string | null,
	slugResolver?: WikiSlugResolver,
): string | null {
	if (!href) return null;

	// Reject schemes (http/https, mailto, tel, javascript, ...) and API links.
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	if (href.startsWith("/api/")) return null;

	const hashIndex = href.indexOf("#");
	const rawPath =
		hashIndex >= 0 ? decodeSegment(href.slice(0, hashIndex)) : decodeSegment(href);

	// Anchor-only link — let the browser/editor handle in-page scrolling.
	if (!rawPath) return null;

	const isMarkdown = MARKDOWN_EXT_RE.test(rawPath);
	const pathWithoutExt = rawPath.replace(MARKDOWN_EXT_RE, "");

	const isAbsolute = pathWithoutExt.startsWith("/");
	const isExplicitRelative =
		pathWithoutExt.startsWith("./") || pathWithoutExt.startsWith("../");
	const isBareSlug =
		!isAbsolute &&
		!isExplicitRelative &&
		!rawPath.includes("/") &&
		!rawPath.includes(".");

	// Bare wiki slugs go through the slug index first.
	if (isBareSlug && slugResolver?.has(pathWithoutExt)) {
		const dir = slugResolver.getDir(pathWithoutExt);
		const pagePath =
			dir === null || dir === "root"
				? `${pathWithoutExt}.md`
				: `${dir}/${pathWithoutExt}.md`;
		return pagePath;
	}

	let basePath: string;
	if (isAbsolute) {
		basePath = pathWithoutExt.replace(/^\/+/, "");
	} else {
		const parentDir = currentPath?.includes("/")
			? currentPath.slice(0, currentPath.lastIndexOf("/"))
			: "";
		basePath = parentDir
			? `${parentDir}/${pathWithoutExt.replace(/^\.\/+/, "")}`
			: pathWithoutExt.replace(/^\.\/+/, "");
	}

	const normalized = normalizePath(basePath);
	if (normalized === null || normalized === "") return null;

	return ensureMarkdownExtension(normalized, isMarkdown);
}
