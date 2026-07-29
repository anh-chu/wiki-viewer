// Builds standalone harness pages that load the PACKAGE's built stylesheet on a
// host that defines only --background and --foreground, which is the contract
// termyard consumes. The app's /s/ page cannot test this: the app never imports
// dist/styles.css, it has its own globals.css, so a fence measured there is the
// APP's CSS, not the package's derived tokens.
//
// Each page measures itself in the browser via getComputedStyle and renders the
// ratios into the DOM, so a single screenshot carries the numbers.
import { readFileSync, writeFileSync } from "node:fs";
import { unified } from "unified";
import rehypeStringify from "rehype-stringify";
import { createLowlight } from "lowlight";
import go from "highlight.js/lib/languages/go";
import ts from "highlight.js/lib/languages/typescript";
import { renderMarkdownToHtml, highlightToLines } from "../dist/index.js";

const lowlight = createLowlight();
lowlight.register({ go, ts, typescript: ts });
const stringify = unified().use(rehypeStringify);
const decode = (s) =>
  s.replace(/&#x26;lt;/g, "<").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function highlightFences(html) {
  return html.replace(/<pre><code class="language-(\w+)">([\s\S]*?)<\/code><\/pre>/g, (whole, lang, body) => {
    if (!lowlight.registered(lang)) return whole;
    const tree = lowlight.highlight(lang, decode(body));
    return '<pre><code class="language-' + lang + '">' + stringify.stringify(tree) + "</code></pre>";
  });
}

const md = readFileSync("/home/sil/workspace/wiki/verify/viewer-regression.md", "utf8").replace(/^---[\s\S]*?---\r?\n/, "");
const body = highlightFences(await renderMarkdownToHtml(md, { docPath: "verify/viewer-regression.md" }));

const sourceSample = [
  "package main",
  "",
  "import \"fmt\"",
  "",
  "/* a block comment",
  "   spanning two lines */",
  "func main() {",
  "\tconst greeting = \"hello\"",
  "\tcount := 42",
  "\tfmt.Println(greeting, count) // trailing comment",
  "}",
].join("\n");

const sourceLines = highlightToLines(sourceSample, "go");
const sourceBlock =
  '<pre class="source-viewer-code text-[13px] font-mono leading-relaxed">' +
  '<table class="w-full border-collapse"><tbody>' +
  sourceLines
    .map(
      (line, i) =>
        '<tr class="hover:bg-muted/50">' +
        '<td class="select-none text-right pr-4 pl-4 py-0 text-muted-foreground text-xs w-[1%] whitespace-nowrap align-top">' +
        (i + 1) +
        "</td>" +
        '<td class="pr-4 py-0 whitespace-pre-wrap break-all">' +
        (line || "&nbsp;") +
        "</td></tr>",
    )
    .join("") +
  "</tbody></table></pre>";

const METER = readFileSync(new URL("./harness-meter.js", import.meta.url), "utf8");

function page(o) {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><title>' + o.title + "</title>",
    '<link rel="stylesheet" href="file:///home/sil/wiki-viewer/packages/viewer/dist/styles.css">',
    "<style>",
    "  /* The host defines ONLY these two tokens. Everything else the viewer needs",
    "     is derived by dist/styles.css from them. theme.css is NOT imported. */",
    "  :root { --background: " + o.bg + "; --foreground: " + o.fg + "; }",
    "  html, body { margin: 0; background: var(--background); color: var(--foreground);",
    "               font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }",
    "  #meter { padding: 12px 20px; border-bottom: 1px solid rgba(128,128,128,.4);",
    "           font: 12px/1.5 ui-monospace, monospace; }",
    "  #meter table { border-collapse: collapse; }",
    "  #meter td, #meter th { padding: 1px 14px 1px 0; text-align: left; }",
    "  #doc { padding: 20px; max-width: 60rem; }",
    "</style></head>",
    "<body>",
    '  <div id="meter">measuring...</div>',
    '  <p style="padding:0 20px;opacity:.7">' + o.note + "</p>",
    '  <div id="doc" class="wv-viewer-root tiptap">' + body + "</div>",
    '  <h3 style="padding:0 20px;opacity:.7;font:12px ui-monospace,monospace">SOURCE FILE VIEW (main.go), same tokens, no fence surface behind it</h3>',
    '  <div id="source" class="wv-viewer-root">' + sourceBlock + "</div>",
    // Deliberate negative control, injected by the meter via innerHTML so the page
    // can prove its own XSS detection works. The sanitized document above contains
    // only post-sanitizer markup, so "no marker fired" there proves nothing on its
    // own; this is the other half of that comparison.
    '  <p style="padding:0 20px;opacity:.7;font:12px ui-monospace,monospace">NEGATIVE CONTROL: the same payload, injected raw, bypassing the sanitizer. It MUST fire.</p>',
    '  <div id="control" style="padding:0 20px"></div>',
    "  <script>" + METER + "</script>",
    "</body></html>",
  ].join("\n");
}

writeFileSync(
  "/tmp/tyverify/pkg-dark-harness.html",
  page({
    title: "@wiki-viewer/viewer on a dark host",
    bg: "oklch(0.12 0 0)",
    fg: "oklch(0.85 0 0)",
    note: "Dark host, using termyard's measured tokens (fg oklch(0.85), near-black bg). Only dist/styles.css is loaded.",
  }),
);
writeFileSync(
  "/tmp/tyverify/pkg-light-harness.html",
  page({
    title: "@wiki-viewer/viewer on a light host",
    bg: "oklch(0.99 0 0)",
    fg: "oklch(0.20 0 0)",
    note: "Light host, same stylesheet, same two tokens. One derivation must clear 4.5:1 on both themes.",
  }),
);

const dark = readFileSync("/tmp/tyverify/pkg-dark-harness.html", "utf8");
// Count against the SANITIZED document html only. Counting the assembled page
// would include the harness's own chrome, and an inline style on my heading would
// read as a sanitizer leak.
const doc = body;
console.log("wrote /tmp/tyverify/pkg-dark-harness.html and pkg-light-harness.html");
console.log("hljs spans:", (dark.match(/class="hljs-/g) || []).length);
console.log("tables:", (doc.match(/<table/g) || []).length);
console.log("fences:", (doc.match(/<pre>/g) || []).length);
console.log("script tags inside doc:", (doc.match(/<script/g) || []).length);
console.log("iframes inside doc:", (doc.match(/<iframe/g) || []).length);
console.log("inline style attrs inside doc:", (doc.match(/ style=/g) || []).length);
console.log("onerror inside doc:", (doc.match(/onerror/g) || []).length);
