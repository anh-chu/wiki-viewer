#!/usr/bin/env node
/**
 * Reproduction for a FILED, deliberately unfixed issue: slash-opacity utilities in
 * the app emit no CSS.
 *
 * Cause: Tailwind v3 cannot apply an alpha modifier to a colour declared as a plain
 * string. tailwind.config.ts uses exactly that style, DEFAULT: "var(--muted)", so
 * bg-muted/50 and its siblings silently produce NO rule. Nothing errors; the
 * treatment is simply absent.
 *
 * The same cause and the same fix were already proven inside packages/viewer, where
 * colour tokens are now FUNCTIONS that receive the modifier and return a color-mix.
 * Applying that to the app would switch ~66 opacity treatments on at once across
 * every surface, which is a whole-app visual change needing its own before-and-after
 * pass, not a footnote in an unrelated commit. So this is filed, not fixed.
 *
 * Run:  node scripts/check-slash-opacity.mjs
 * Requires a built app, i.e. .next/static/chunks/*.css must exist.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const chunkDir = path.join(root, ".next/static/chunks");
if (!existsSync(chunkDir)) {
  console.error("No built CSS found. Run the app build first, then re-run this.");
  process.exit(2);
}
const css = readdirSync(chunkDir)
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(path.join(chunkDir, f), "utf8"))
  .join("");

// Sanity check first. A negative result is worthless if the haystack is wrong, and
// this exact check is what stopped an earlier measurement being reported backwards.
for (const canary of [".flex", ".bg-muted"]) {
  if (!css.includes(canary + "{") && !css.includes(canary + ",")) {
    console.error(`Sanity check failed: ${canary} absent, so this CSS is not what it looks like.`);
    process.exit(2);
  }
}

function collectSources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/[.]tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SLASH = /\b(bg|text|border|ring|divide|from|via|to|placeholder|shadow|outline|decoration|caret|accent|fill|stroke)-[a-z][a-z0-9-]*\/(\d{1,3})\b/g;
const used = new Map();
for (const file of collectSources(path.join(root, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(SLASH)) {
    if (!used.has(m[0])) used.set(m[0], path.relative(root, file));
  }
}

const escape = (t) => [...t].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : "\\" + c)).join("");

/**
 * Is this class actually GENERATED as a utility, as opposed to merely mentioned?
 *
 * A naive substring search reports false positives, and did: the only occurrence of
 * bg-muted\/50 in the app's CSS is
 *     [data-skin=editorial] .bg-muted\/50.border-b{background-color:var(--background)!important}
 * which is a hand-written skin override REFERENCING the class, not Tailwind emitting
 * the utility. So require the class to terminate its compound selector, optionally
 * behind a variant prefix such as hover\:.
 */
function isGenerated(cls) {
  const esc = escape(cls);
  let from = 0;
  for (;;) {
    const at = css.indexOf(esc, from);
    if (at === -1) return false;
    from = at + esc.length;
    const before = css.slice(Math.max(0, at - 2), at);
    const after = css[from];
    const attachedToClassOrVariant = before.endsWith(".") || before.endsWith("\\:");
    if (attachedToClassOrVariant && (after === "{" || after === "," || after === ":")) return true;
  }
}

const emitted = [];
const missing = [];
for (const [cls, where] of used) {
  (isGenerated(cls) ? emitted : missing).push([cls, where]);
}

console.log(`slash-opacity utilities used in src/: ${used.size}`);
console.log(`  emit a rule:      ${emitted.length}`);
console.log(`  emit NOTHING:     ${missing.length}`);
if (emitted.length) {
  console.log("\nthe ones that DO emit, and why they are different:");
  for (const [cls, where] of emitted) console.log(`  ${cls.padEnd(30)} ${where}`);
}
console.log("\nfirst 15 that emit nothing:");
for (const [cls, where] of missing.slice(0, 15)) console.log(`  ${cls.padEnd(30)} ${where}`);
console.log(
  missing.length
    ? "\nFILED, NOT FIXED. See docs/known-issue-slash-opacity.md for the ruling."
    : "\nAll slash-opacity utilities emit. This issue is resolved; delete this script.",
);
