import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { fileExt } from "../file-kind";
import { ensureLanguage, languageForExt } from "../lowlight";
import { highlightToLines } from "../markdown/highlight-lines";

const MAX_INITIAL_LINES = 500;

export function SourceViewer({
  content,
  filename,
}: {
  content: string;
  filename: string;
}) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const lineCount = lines.length;
  const [showAll, setShowAll] = useState(lineCount <= MAX_INITIAL_LINES);
  const visibleLines = showAll ? lines : lines.slice(0, MAX_INITIAL_LINES);

  // Highlighted markup, one entry per line, or null while loading / unsupported.
  const [highlighted, setHighlighted] = useState<string[] | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const language = languageForExt(fileExt(filename));
    if (!language) {
      setHighlighted(null);
      return;
    }
    const request = ++requestRef.current;
    let cancelled = false;
    void (async () => {
      const available = await ensureLanguage(language);
      // A second file can be opened while a grammar is still loading; only the
      // most recent request may paint.
      if (cancelled || request !== requestRef.current) return;
      if (!available) {
        setHighlighted(null);
        return;
      }
      try {
        setHighlighted(highlightToLines(content, language));
      } catch {
        // Highlighting is decorative: a grammar that throws must not cost the
        // user the file.
        setHighlighted(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [content, filename]);

  return (
    <div className="wv-viewer-root flex-1 overflow-auto">
      <div className="mx-auto max-w-4xl">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
          <span className="text-xs text-muted-foreground font-mono">{filename}</span>
          <span className="text-xs text-muted-foreground">
            {lineCount.toLocaleString()} lines
          </span>
        </div>
        <pre className="source-viewer-code text-[13px] font-mono leading-relaxed">
          <table className="w-full border-collapse">
            <tbody>
              {visibleLines.map((line, i) => (
                <tr key={i} className="hover:bg-muted/50">
                  <td className="select-none text-right pr-4 pl-4 py-0 text-muted-foreground text-xs w-[1%] whitespace-nowrap align-top">
                    {i + 1}
                  </td>
                  {highlighted ? (
                    <td
                      className="pr-4 py-0 whitespace-pre-wrap break-all"
                      // Markup comes from lowlight's own hast serialisation, so
                      // file contents are escaped by the serialiser, never by hand.
                      dangerouslySetInnerHTML={{ __html: highlighted[i] || "&nbsp;" }}
                    />
                  ) : (
                    <td className="pr-4 py-0 whitespace-pre-wrap break-all">{line || "\u00a0"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </pre>
        {!showAll && lineCount > MAX_INITIAL_LINES && (
          <div className="flex justify-center py-4 border-t">
            <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
              Show all {lineCount.toLocaleString()} lines
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
