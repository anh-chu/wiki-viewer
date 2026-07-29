import type { FileKind } from "../file-kind";
import { cn } from "../lib/cn";
import {
  BinaryViewer,
  HtmlViewer,
  ImageViewer,
  MediaViewer,
  PdfViewer,
} from "./asset-viewers";
import { CsvViewer } from "./csv-viewer";
import { MarkdownViewer } from "./markdown-viewer";
import { SourceViewer } from "./source-viewer";

export interface FileViewerProps {
  kind: FileKind;
  content: string;
  filename: string;
  assetUrl?: string;
  assetUrlTransform?: (url: string) => string;
  maxWidth?: string;
  marginLeft?: string;
  className?: string;
}

export function FileViewer({
  kind,
  content,
  filename,
  assetUrl,
  assetUrlTransform,
  maxWidth,
  marginLeft,
  className,
}: FileViewerProps) {
  return (
    <div
      className={cn("wv-viewer-root flex flex-col min-h-0 h-full", className)}
    >
      {kind === "markdown" ? (
        <MarkdownViewer
          content={content}
          filename={filename}
          assetUrlTransform={assetUrlTransform}
          maxWidth={maxWidth}
          marginLeft={marginLeft}
        />
      ) : kind === "image" ? (
        <ImageViewer src={assetUrl} filename={filename} />
      ) : kind === "pdf" ? (
        <PdfViewer src={assetUrl} filename={filename} />
      ) : kind === "media" ? (
        <MediaViewer src={assetUrl} filename={filename} />
      ) : kind === "html" ? (
        <HtmlViewer content={content} filename={filename} />
      ) : kind === "csv" ? (
        <CsvViewer content={content} />
      ) : kind === "source" || kind === "text" ? (
        <SourceViewer content={content} filename={filename} />
      ) : (
        <BinaryViewer src={assetUrl} filename={filename} />
      )}
    </div>
  );
}
