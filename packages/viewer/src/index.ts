export { fileKindFor, fileExt } from "./file-kind";
export type { FileKind } from "./file-kind";

export { FileViewer } from "./components/file-viewer";
export type { FileViewerProps } from "./components/file-viewer";

export { MarkdownViewer } from "./components/markdown-viewer";

export { SourceViewer } from "./components/source-viewer";
export { CsvViewer } from "./components/csv-viewer";

export {
  ImageViewer,
  PdfViewer,
  MediaViewer,
  HtmlViewer,
  BinaryViewer,
} from "./components/asset-viewers";

export { renderMarkdownToHtml } from "./markdown/to-html";

// Source-file highlighting. Exported so a host can pre-highlight, and so the
// verification gates can assert on it directly.
export { highlightToLines } from "./markdown/highlight-lines";
export { ensureLanguage, languageForExt } from "./lowlight";
export type { RenderMarkdownOptions } from "./markdown/to-html";
