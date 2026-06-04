/**
 * Shared extension sets for text-indexable files.
 * Copied from src/app/api/wiki/content/route.ts so the indexer and
 * the route share a single definition without importing a route module from lib.
 */

export const TEXT_EXTS = new Set([
	"txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv", "tsv",
	"xml", "html", "css", "js", "ts", "tsx", "jsx", "sh", "bash",
	"zsh", "rb", "py", "go", "rs", "java", "c", "cpp", "h", "php",
	"swift", "kt", "lua", "sql", "scss", "mmd", "mermaid", "ini",
	"env", "log", "conf",
]);

export const MARKDOWN_EXTS = new Set(["md", "markdown"]);

export function isIndexableExt(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTS.has(ext);
}

export function isMarkdownExt(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MARKDOWN_EXTS.has(ext);
}
