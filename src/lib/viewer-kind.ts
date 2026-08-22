import type { ViewerKind } from "@/types/wiki";

export function viewerKindFor(
	filename: string,
	nodeType: "file" | "app" | "dir" | "node-app",
): ViewerKind {
	if (nodeType === "node-app") return "node-app";
	if (nodeType === "app") return "app";
	if (nodeType === "dir") return "fallback";
	const base = filename.split("/").pop() ?? filename;
	// Dotfile with no real extension (".env", ".gitignore", ".bashrc"):
	// `".env".split(".").pop()` -> "env", which would match nothing below,
	// so treat any leading-dot name as text and let the viewer sniff bytes.
	if (base.startsWith(".") && base.indexOf(".", 1) === -1) return "source";
	const fileExt = filename.split(".").pop()?.toLowerCase() ?? "";
	// No extension at all ("Makefile", "LICENSE", "Dockerfile"): assume text.
	if (!fileExt) return "source";
	if (["md", "markdown"].includes(fileExt)) return "editor";
	if (fileExt === "txt") return "text";
	if (["csv", "tsv"].includes(fileExt)) return "csv";
	if (fileExt === "pdf") return "pdf";
	if (["mmd", "mermaid"].includes(fileExt)) return "mermaid";
	if (fileExt === "ipynb") return "notebook";
	if (fileExt === "excalidraw") return "canvas";
	if (
		["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"].includes(
			fileExt,
		)
	)
		return "image";
	if (
		["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac"].includes(
			fileExt,
		)
	)
		return "media";
	if (fileExt === "docx") return "docx";
	if (["xlsx", "xlsm"].includes(fileExt)) return "xlsx";
	if (fileExt === "pptx") return "pptx";
	if (fileExt === "html") return "html";
	if (
		[
			"py", "js", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp", "h",
			"sh", "bash", "zsh", "rb", "php", "swift", "kt", "lua", "sql", "yaml",
			"yml", "toml", "json", "xml", "css", "scss",
		].includes(fileExt)
	)
		return "source";
	// Default: assume text and let SourceViewer sniff the bytes. If the file is
	// actually binary, SourceViewer degrades to a download/reveal fallback.
	// This avoids a brittle text-extension whitelist that always misses
	// something (.env, .ini, .lock, .gradle, .properties, ...).
	return "source";
}
