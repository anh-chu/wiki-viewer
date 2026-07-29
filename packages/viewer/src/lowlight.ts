/**
 * One lowlight instance shared by markdown fences and source files.
 *
 * The 13 grammars the markdown editor needs are registered eagerly, because a
 * fence must highlight synchronously as the document loads. Everything else is
 * registered ON DEMAND from an explicit map: source files are opened one at a
 * time, so paying for a grammar at open is cheaper than shipping ~190 of them.
 *
 * The map is explicit rather than a template-literal import on purpose. A dynamic
 * import with an interpolated path makes the bundler emit every matching module,
 * which is exactly the bloat this is meant to avoid.
 */
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export const lowlight = createLowlight({
  bash,
  css,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
});

/** Extra grammars, loaded only when a file of that type is actually opened. */
const LAZY_GRAMMARS: Record<string, () => Promise<{ default: unknown }>> = {
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  scss: () => import("highlight.js/lib/languages/scss"),
  swift: () => import("highlight.js/lib/languages/swift"),
  toml: () => import("highlight.js/lib/languages/ini"),
  vim: () => import("highlight.js/lib/languages/vim"),
};

/** file extension -> hljs language id */
const EXT_TO_LANGUAGE: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cfg: "ini",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  diff: "diff",
  dockerfile: "dockerfile",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  lua: "lua",
  makefile: "makefile",
  md: "markdown",
  mjs: "javascript",
  mk: "makefile",
  patch: "diff",
  php: "php",
  pl: "perl",
  properties: "ini",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  vim: "vim",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function languageForExt(ext: string): string | null {
  return EXT_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

const pending = new Map<string, Promise<void>>();

/**
 * Make a grammar available, loading it if necessary. Resolves false when the
 * language is unknown, so the caller can fall back to plain text rather than
 * rendering nothing.
 */
export async function ensureLanguage(language: string): Promise<boolean> {
  if (lowlight.registered(language)) return true;
  const loader = LAZY_GRAMMARS[language];
  if (!loader) return false;
  let inFlight = pending.get(language);
  if (!inFlight) {
    inFlight = loader().then((mod) => {
      if (!lowlight.registered(language)) {
        lowlight.register({ [language]: mod.default as never });
      }
    });
    pending.set(language, inFlight);
  }
  await inFlight;
  return lowlight.registered(language);
}
