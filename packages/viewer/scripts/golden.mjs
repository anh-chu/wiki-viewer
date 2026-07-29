#!/usr/bin/env node
/**
 * ABSOLUTE output gate.
 *
 * The headline parity test is relative: package output === app output across 60
 * documents. But both copies of the sanitize schema are patched together on
 * purpose, to stop them drifting, which means a regression introduced into BOTH
 * sides passes parity perfectly. That is not hypothetical: the original defect in
 * this package was sanitizing being switched off so that a comparison would agree.
 *
 * So this compares rendered output against a golden file checked into the repo. If
 * the rendering changes, a human has to read the diff and accept it with
 * `npm run golden:update`. Relative tests catch drift between implementations; only
 * an absolute fixture catches both implementations moving in step.
 *
 * Credit: the gap was identified by the planner (session 019f936d).
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp } from "./artifact-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.join(root, "test-fixtures/golden-input.md");
const goldenPath = path.join(root, "test-fixtures/golden-output.html");
const update = process.argv.includes("--update");

console.log(buildStamp(path.join(root, "dist")));

const { renderMarkdownToHtml } = await import(path.join(root, "dist/index.js"));
const markdown = readFileSync(inputPath, "utf8");
const actual = await renderMarkdownToHtml(markdown, { docPath: "test-fixtures/golden-input.md" });

if (update) {
  writeFileSync(goldenPath, actual);
  console.log("golden output UPDATED. Read the diff before committing it.");
  process.exit(0);
}

let expected;
try {
  expected = readFileSync(goldenPath, "utf8");
} catch {
  console.log("FAIL  no golden output on disk. Run: npm run golden:update");
  process.exit(1);
}

if (actual === expected) {
  // Spot-assert the properties the golden is there to protect, so a future
  // wholesale --update cannot quietly bless the loss of one of them.
  const invariants = [
    ['wiki-link anchors', /data-wiki-link="true"[^>]*data-slug="some-page"/],
    ['wiki-link class', /class="wiki-link"/],
    ['table alignment as attributes', /<th align="center"|<td align="center"/],
    ['task list markup', /data-type="taskList"[^>]*class="task-list"/],
    ['fence language class', /class="language-go"/],
    ['provider embed kept', /youtube\.com\/embed/],
  ];
  const missing = invariants.filter(([, re]) => !re.test(actual)).map(([name]) => name);
  if (missing.length) {
    console.log("FAIL  golden matches but lost: " + missing.join(", "));
    process.exit(1);
  }
  console.log(`GOLDEN OK  ${expected.length} bytes, ${invariants.length} invariants present`);
  process.exit(0);
}

// Show the first divergence with context rather than dumping both documents.
const a = actual.split("\n");
const b = expected.split("\n");
let i = 0;
while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
console.log("FAIL  rendered output differs from the golden file at line " + (i + 1));
for (let j = Math.max(0, i - 2); j < Math.min(Math.max(a.length, b.length), i + 3); j++) {
  if (a[j] === b[j]) console.log("    " + (b[j] ?? ""));
  else {
    console.log("  - " + (b[j] ?? "<missing>"));
    console.log("  + " + (a[j] ?? "<missing>"));
  }
}
console.log("\nIf this change is intended: npm run golden:update, then READ the diff.");
process.exit(1);
