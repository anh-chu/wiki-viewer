/**
 * Highlight source text and return one HTML string PER LINE.
 *
 * The source viewer renders a line-number gutter beside each line, so it needs
 * per-line markup. Splitting highlighted HTML on newlines naively would break
 * every span that crosses a line boundary, which is most block comments and every
 * multi-line string. So the hast tree is walked and, at each newline, the open
 * element stack is closed and reopened on the next line, which is what an editor
 * does.
 *
 * Text is serialised through hast, never concatenated by hand, so file contents
 * cannot inject markup.
 */
import { unified } from "unified";
import rehypeStringify from "rehype-stringify";
import { lowlight } from "../lowlight";

const stringify = unified().use(rehypeStringify);

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function serialise(children: HastNode[]): string {
  return stringify.stringify({ type: "root", children } as never);
}

/** Rebuild the currently open element chain around a line's content. */
function wrap(stack: HastNode[], children: HastNode[]): HastNode[] {
  let current = children;
  for (let i = stack.length - 1; i >= 0; i--) {
    const open = stack[i];
    current = [{ type: "element", tagName: open.tagName, properties: open.properties, children: current }];
  }
  return current;
}

export function highlightToLines(code: string, language: string): string[] {
  const tree = lowlight.highlight(language, code) as unknown as HastNode;
  const lines: string[] = [];
  let currentLine: HastNode[] = [];
  const stack: HastNode[] = [];

  const flush = () => {
    lines.push(serialise(wrap(stack, currentLine)));
    currentLine = [];
  };

  const walk = (nodes: HastNode[]): void => {
    for (const node of nodes) {
      if (node.type === "text") {
        const parts = (node.value ?? "").split("\n");
        parts.forEach((part, index) => {
          if (index > 0) flush();
          if (part) currentLine.push({ type: "text", value: part });
        });
        continue;
      }
      if (node.type === "element") {
        stack.push(node);
        // Children are appended to whichever line they land on; the stack keeps
        // the span reopened across any newline inside them.
        const outer = currentLine;
        currentLine = [];
        const innerStackDepth = stack.length;
        walk(node.children ?? []);
        const inner = currentLine;
        stack.length = innerStackDepth - 1;
        currentLine = outer.concat([
          { type: "element", tagName: node.tagName, properties: node.properties, children: inner },
        ]);
        continue;
      }
      if (node.children) walk(node.children);
    }
  };

  walk(tree.children ?? []);
  lines.push(serialise(wrap(stack, currentLine)));
  return lines;
}
