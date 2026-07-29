/**
 * Absence-testing for the shipped stylesheet.
 *
 * Every other gate inspects what IS in the artifact, so none of them can notice a
 * utility that was never emitted, for example if a content glob stops matching or
 * the extractor misses a bracketed arbitrary value. Tailwind escapes those
 * selectors, so text-[13px] ships as .text-\[13px\] and a naive grep for the
 * source spelling finds nothing even when the rule is present. This compares
 * against the escaped form.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Structural hooks rather than utilities: styled by hand-written rules, so having
// no utility rule of their own is correct.
const NON_UTILITY = new Set([
  "group",
  "peer",
  "tiptap",
  "wv-viewer-root",
  "source-viewer-code",
  "md-code",
  "wiki-link",
  "task-list",
  // A marker class with no styling of its own, used only as a query hook.
  "mermaid-preview",
  // cva() option keys, captured because they sit inside the same call as the
  // class strings. They are never class names.
  "variant",
  "size",
]);

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/[.]tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function collectUsedClasses(srcDir) {
  const used = new Set();
  const classAttr = /className=(?:"([^"]*)"|[{]`([^`]*)`[}]|[{]cn[(]([\s\S]*?)[)][}])/g;
  for (const file of collectSourceFiles(srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(classAttr)) {
      const raw = match[1] ?? match[2] ?? match[3] ?? "";
      // Only static string fragments; anything interpolated is skipped.
      for (const fragment of raw.split(/["'`]/)) {
        for (const rawToken of fragment.split(/\s+/)) {
          // Trailing punctuation survives the whitespace split when the string sits
          // inside a call, e.g. cn("a b", variant, size).
          const token = rawToken.replace(/[,;]+$/, "");
          if (!token) continue;
          // Strip arbitrary values first: they may legitimately contain
          // uppercase, dots and parens that a bare identifier may not.
          const withoutArbitrary = token.replace(/\[[^\]]*\]/g, "");
          if (/[${}?]/.test(withoutArbitrary)) continue;
          // Expression fragments captured from cn(...) calls, e.g. "activeUid"
          // or "h.uid", are not class names: utilities are lowercase, and a dot
          // only ever follows a digit (text-1.5).
          if (/[A-Z]/.test(withoutArbitrary)) continue;
          if (/(^|[^0-9])[.]/.test(withoutArbitrary)) continue;
          if (!/^[a-z0-9-]/.test(token)) continue;
          used.add(token);
        }
      }
    }
  }
  return used;
}

// Tailwind escapes every character outside [A-Za-z0-9_-]; a comma becomes \2c
// followed by a space.
export function escapeClassName(token) {
  let out = "";
  for (const ch of token) {
    if (/[A-Za-z0-9_-]/.test(ch)) out += ch;
    else if (ch === ",") out += "\\2c ";
    else out += "\\" + ch;
  }
  return out;
}

export function findMissingClasses(css, srcDir) {
  const used = collectUsedClasses(srcDir);
  const missing = [...used]
    .filter((token) => !NON_UTILITY.has(token))
    .filter((token) => !css.includes("." + escapeClassName(token)));
  return { used, missing };
}
