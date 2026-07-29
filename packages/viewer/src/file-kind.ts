export type FileKind =
  | "markdown"
  | "source"
  | "text"
  | "csv"
  | "image"
  | "media"
  | "pdf"
  | "html"
  | "binary";

export function fileExt(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

export function fileKindFor(filename: string): FileKind {
  const e = fileExt(filename);
  if (["md", "markdown"].includes(e)) return "markdown";
  if (["csv", "tsv"].includes(e)) return "csv";
  if (["pdf"].includes(e)) return "pdf";
  if (["html", "htm"].includes(e)) return "html";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "ico", "bmp"].includes(
      e
    )
  )
    return "image";
  if (
    ["mp4", "webm", "mov", "m4v", "mp3", "wav", "ogg", "m4a", "aac"].includes(
      e
    )
  )
    return "media";
  if (["txt", "log", "ini", "env", "conf"].includes(e)) return "text";
  if (
    [
      "py",
      "js",
      "ts",
      "tsx",
      "jsx",
      "go",
      "rs",
      "java",
      "c",
      "cpp",
      "h",
      "sh",
      "bash",
      "zsh",
      "rb",
      "php",
      "swift",
      "kt",
      "lua",
      "sql",
      "yaml",
      "yml",
      "toml",
      "json",
      "xml",
      "css",
      "scss",
      "mmd",
      "mermaid",
    ].includes(e)
  )
    return "source";
  return "binary";
}
