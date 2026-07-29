import { useMemo } from "react";

export function CsvViewer({ content }: { content: string }) {
  const rows = useMemo(() => {
    return content
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const cells: string[] = [];
        let current = "";
        let inQuotes = false;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          if (ch === '"') {
            inQuotes = !inQuotes;
          } else if ((ch === "," || ch === "\t") && !inQuotes) {
            cells.push(current.trim());
            current = "";
          } else {
            current += ch;
          }
        }
        cells.push(current.trim());
        return cells;
      });
  }, [content]);

  if (rows.length === 0) return null;
  const header = rows[0];
  const body = rows.slice(1);

  return (
    <div className="wv-viewer-root flex-1 overflow-auto">
      <div className="mx-auto max-w-6xl p-4">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="text-left px-3 py-2 border-b-2 border-border font-medium bg-muted/50 whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, i) => (
              <tr key={i} className="hover:bg-muted/30">
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="px-3 py-1.5 border-b border-border/50 whitespace-nowrap"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
