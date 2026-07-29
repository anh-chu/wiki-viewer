import { Download, FileText } from "lucide-react";
import { fileExt } from "../file-kind";
import { Button } from "../ui/button";

export function ImageViewer({
  src,
  filename,
}: {
  src?: string;
  filename: string;
}) {
  if (!src) {
    return (
      <div className="wv-viewer-root flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No asset URL provided</p>
      </div>
    );
  }
  return (
    <div className="wv-viewer-root flex-1 flex items-center justify-center p-8 bg-[repeating-conic-gradient(var(--wv-muted)_0%_25%,transparent_0%_50%)] bg-[length:20px_20px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={filename}
        className="max-w-full max-h-[80vh] object-contain rounded-sm"
      />
    </div>
  );
}

export function PdfViewer({
  src,
  filename,
}: {
  src?: string;
  filename: string;
}) {
  if (!src) {
    return (
      <div className="wv-viewer-root flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No asset URL provided</p>
      </div>
    );
  }
  return (
    <div className="wv-viewer-root flex-1 flex flex-col min-h-0">
      {/*
        NO sandbox here, deliberately, and this is a considered exception to the
        rule applied to the html viewer above.

        A hostile PDF's script runs inside the browser's own out-of-process PDF
        viewer, which has no access to this page's DOM, so it cannot reach the
        host's origin, its cookies, or anything else the html-file case could.
        sandbox="" would block plugin instantiation and therefore break PDF
        rendering altogether, so sandboxing here removes a working feature to
        mitigate a risk that never reaches the origin.

        Do NOT copy this pattern to a frame that renders HTML: there the script
        runs in THIS origin, which is why the html viewer uses sandbox="".

        Knowingly accepted residual risk: a link inside a PDF can still attempt
        top-level navigation, so this remains a phishing surface, not a
        code-execution one.
      */}
      <iframe
        src={src}
        title={filename}
        className="flex-1 w-full border-0"
        style={{ minHeight: "80vh" }}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

export function MediaViewer({
  src,
  filename,
}: {
  src?: string;
  filename: string;
}) {
  if (!src) {
    return (
      <div className="wv-viewer-root flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">No asset URL provided</p>
      </div>
    );
  }
  const e = fileExt(filename);
  const isVideo = ["mp4", "webm", "mov", "m4v"].includes(e);
  return (
    <div className="wv-viewer-root flex-1 flex items-center justify-center p-8">
      {isVideo ? (
        <video
          controls
          className="max-w-full max-h-[80vh] rounded-sm"
          src={src}
        />
      ) : (
        <div className="w-full max-w-md">
          <audio controls className="w-full" src={src} />
          <p className="text-center text-sm text-muted-foreground mt-3">
            {filename}
          </p>
        </div>
      )}
    </div>
  );
}

export function HtmlViewer({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  return (
    <div className="wv-viewer-root flex-1 flex flex-col min-h-0">
      {/*
        sandbox="" is deliberate and must stay empty.
        allow-scripts together with allow-same-origin cancels the sandbox: a
        framed document granted both can reach its own origin and remove its own
        sandbox attribute. The frame inherits the HOST's origin, and a host whose
        API is authenticated by a same-origin cookie would then be reachable by
        script from an arbitrary .html file the user merely opened. HTML and CSS
        still render fine with an empty sandbox; only script is denied.
      */}
      <iframe
        srcDoc={content}
        title={filename}
        className="flex-1 w-full border-0 bg-white"
        style={{ minHeight: "80vh" }}
        sandbox=""
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

export function BinaryViewer({
  src,
  filename,
}: {
  src?: string;
  filename: string;
}) {
  return (
    <div className="wv-viewer-root flex-1 flex flex-col items-center justify-center gap-4 p-8">
      <FileText className="h-12 w-12 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{filename}</p>
      {src ? (
        <a href={src} download={filename}>
          <Button size="sm" variant="outline" className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Download file
          </Button>
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">No asset URL provided</p>
      )}
    </div>
  );
}
