#!/usr/bin/env node
/**
 * SSR safety gate. The bundle once ran document.createElement at module scope
 * (via decode-named-character-reference's browser build), which made importing
 * this package throw in any server runtime and 500'd the host's page on every
 * request while next build still exited 0.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp } from "./artifact-identity.mjs";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
console.log(buildStamp(dist));

const mod = await import(path.join(dist, "index.js"));
const html = await mod.renderMarkdownToHtml("# t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
const expected = ["FileViewer", "MarkdownViewer", "SourceViewer", "CsvViewer", "renderMarkdownToHtml", "fileKindFor"];
const missing = expected.filter((k) => !(k in mod));
const checks = [
  ["imports with no document", true],
  ["exports present", missing.length === 0, missing.join(",")],
  ["renders GFM table", /<table/.test(html)],
  ["classifies files", mod.fileKindFor("x.md") === "markdown" && mod.fileKindFor("x.png") === "image"],
];
let bad = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}
console.log(bad ? "SSR CHECK FAILED" : "SSR CHECK OK");
process.exit(bad ? 1 : 0);
