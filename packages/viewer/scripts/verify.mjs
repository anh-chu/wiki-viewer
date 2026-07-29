#!/usr/bin/env node
/**
 * Package invariants. Run with: npm run verify (after npm run build).
 *
 * Every check here exists because something actually broke:
 *   SSR      the bundle once ran document.createElement at module scope, which
 *            made importing the package 500 the host's server-rendered page.
 *   XSS      sanitizing was once switched OFF to win a byte-parity test, which
 *            let <script> through into the host's origin via rehype-raw.
 *   SANDBOX  the html viewer once used allow-scripts WITH allow-same-origin,
 *            a combination that cancels the sandbox entirely.
 *   CSS      the stylesheet once shipped a global reset and a light :root
 *            palette, restyling the host app and making code dark-on-dark.
 *   AA       syntax colours were once bound to host tokens that do not exist,
 *            landing at 4:1 on a dark theme.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { artifactIdentity } from "./artifact-identity.mjs";
import { findMissingClasses, escapeClassName } from "./css-completeness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
console.log(artifactIdentity(path.join(root, "dist")));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};


// ── 0. STALENESS: never measure an artifact older than the source ───────────
console.log("\nArtifact freshness");
const distStat = statSync(path.join(root, "dist/index.js"));
const newerSources = [];
const scanTree = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) scanTree(full);
    else if (statSync(full).mtimeMs > distStat.mtimeMs) newerSources.push(path.relative(root, full));
  }
};
scanTree(path.join(root, "src"));
// Two sessions spent an afternoon quoting measurements of different bundles at
// each other, and twice a stale process served an old build behind a passing
// check. A gate that can pass against yesterday's dist is not a gate.
check(
  "dist is newer than every source file",
  newerSources.length === 0,
  newerSources.slice(0, 5).join(" "),
);

// ── 1. SSR: the built bundle must import in a process with no DOM ───────────
console.log("\nSSR safety");
const mod = await import(path.join(root, "dist/index.js"));
check("bundle imports with no document", true);
check(
  "exports intact",
  ["FileViewer", "MarkdownViewer", "renderMarkdownToHtml", "fileKindFor"].every((k) => k in mod),
);

// ── 2. Markdown rendering + sanitizing by default ───────────────────────────
console.log("\nMarkdown pipeline");
const hostile = [
  "Text with a [[wiki-slug|alias]] link.",
  "",
  "- [ ] todo",
  "- [x] done",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "<script>alert(1)</script>",
  '<img src=x onerror="alert(2)">',
  '<a href="javascript:alert(3)">bad</a>',
  '<a href="vbscript:alert(4)">bad</a>',
  '<iframe src="https://evil.example/x"></iframe>',
  '<div onclick="alert(5)">click</div>',
  '<form action="https://evil.example"></form>',
  '<object data="https://evil.example/x"></object>',
  '<embed src="https://evil.example/x">',
  '<p style="background:url(javascript:alert(6))">s</p>',
].join("\n");

const html = await mod.renderMarkdownToHtml(hostile, { docPath: "d.md" });
check("GFM tables render", /<table/.test(html));
for (const [label, re] of [
  ["script blocked", /<script/i],
  ["onerror blocked", /onerror/i],
  ["onclick blocked", /onclick/i],
  ["javascript: blocked", /javascript:/i],
  ["vbscript: blocked", /vbscript:/i],
  ["foreign frame blocked", /evil\.example/],
  ["object blocked", /<object/i],
  ["embed blocked", /<embed/i],
  ["form blocked", /<form/i],
  ["style attr blocked", /style="background/i],
]) {
  check(label, !re.test(html));
}
for (const [label, re] of [
  ["wiki-link class kept", /class="wiki-link"/],
  ["task-list class kept", /class="task-list"/],
  ["wiki data attrs kept", /data-wiki-link="true"/],
]) {
  check(label, re.test(html));
}
// A realistic 11-character id: the provider detector requires a well-formed one.
// UI spoofing. In a host where the user types into terminals, a convincing fake
// prompt painted over the app is an attack, so an untrusted file must not be able
// to borrow the host's utility classes or set inline CSS.
const spoof = await mod.renderMarkdownToHtml(
  [
    '<div class="fixed inset-0 z-50 bg-black">fake ui</div>',
    '<table><tr><td style="position:fixed;inset:0;z-index:9999">spoof</td></tr></table>',
    '<p id="terminal-pane">id collision</p>',
    '<a href="https://ok.example" target="_blank">link</a>',
    '<svg onload="alert(1)"></svg>',
    '<base href="https://evil.example/">',
  ].join("\n\n"),
  { docPath: "d.md" },
);
check("host utility classes dropped", !/fixed|inset-0|z-50/.test(spoof));
check("inline style dropped", !/ style=/.test(spoof));
check("svg stripped", !/<svg/.test(spoof));
check("base stripped", !/<base/.test(spoof));
check("id namespaced away from host ids", !/id="terminal-pane"/.test(spoof));
check("target=_blank dropped (no window.opener)", !/target=/.test(spoof));

// A src-less <iframe> loads about:blank, which is same-origin with the host, so a
// filtered src must take the element with it rather than leaving an empty frame.
const framedEvil = await mod.renderMarkdownToHtml('<iframe src="https://evil.example/x"></iframe>', {});
check("src-less iframe element removed entirely", !/<iframe/.test(framedEvil));
// hast-util-sanitize's defaultSchema COERCES a surviving <input> into a disabled
// checkbox rather than dropping it, so a hostile password field became stray
// debris in the document. Inputs are only legitimate as task-list checkboxes.
const withForm = await mod.renderMarkdownToHtml(
  '<form action="https://evil.example"><input name="pw" type="password"></form>\n\n- [x] real task\n',
  {},
);
check("stray input from a form is removed", !/name="user-content-pw"/.test(withForm));
check("task-list checkbox survives", (withForm.match(/<input/g) || []).length === 1);


const embed = await mod.renderMarkdownToHtml('<video src="https://youtu.be/dQw4w9WgXcQ"></video>', {});
check("provider embed still allowed", /<iframe/.test(embed) && /youtube\.com\/embed/.test(embed));
const optOut = await mod.renderMarkdownToHtml(hostile, { sanitize: false });
check("sanitize:false is the ONLY unsafe path", /<script/i.test(optOut));

// ── 3. The html viewer must never grant script ──────────────────────────────
console.log("\nHtml viewer sandbox");
const framed = renderToStaticMarkup(
  createElement(mod.FileViewer, { kind: "html", filename: "x.html", content: "<h1>hi</h1>" }),
);
check('sandbox="" present', /sandbox=""/.test(framed));
check("allow-scripts absent", !/allow-scripts/.test(framed));
check("allow-same-origin absent", !/allow-same-origin/.test(framed));


// ── 3b. Source-file highlighting ───────────────────────────────────
console.log("\nSource highlighting");
const { highlightToLines } = await import("../dist/index.js").then((m) => m).catch(() => ({}));
const hl = mod.highlightToLines ?? highlightToLines;
if (typeof hl !== "function") {
  check("highlightToLines exported", false);
} else {
  const goSample = [
    "package main",
    "/* block comment",
    "   second line */",
    'func main() { const s = "x" }',
    '// <div onclick="alert(1)">',
  ].join("\n");
  const out = hl(goSample, "go");
  check("line count preserved", out.length === goSample.split("\n").length);
  // A span crossing a newline must be reopened, or the rest of the file inherits
  // the comment colour.
  check("multi-line span reopened per line", out[1].includes("hljs-comment") && out[2].includes("hljs-comment"));
  check("keywords highlighted", out[3].includes("hljs-keyword"));
  // The markup is injected with dangerouslySetInnerHTML, so escaping is load-bearing.
  check("file text cannot become markup", !/<div/.test(out[4]));
  const roundTrip = out
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x3C;/g, "<")
    .replace(/&#x26;/g, "&")
    .replace(/&#x22;/g, '"');
  check("no source text lost or altered", roundTrip === goSample);
}
check("language map resolves by extension", mod.languageForExt?.("kt") === "kotlin" && mod.languageForExt?.("zzz") === null);
const lazyOk = await mod.ensureLanguage?.("kotlin");
check("grammar loads on demand", lazyOk === true);
check("unknown grammar fails soft", (await mod.ensureLanguage?.("nonexistent")) === false);


// ── 3c. Declared boundaries around mermaid ──────────────────────────────
console.log("\nMermaid boundary");
const bundleFiles = readdirSync(path.join(root, "dist")).filter((f) => /^index-.*\.js$/.test(f));
const bundle = bundleFiles.map((f) => readFileSync(path.join(root, "dist", f), "utf8")).join("");
// mermaid applies DOMPurify to the SVG it produces ONLY when securityLevel is not
// "loose", and that SVG is injected with dangerouslySetInnerHTML AFTER
// rehype-sanitize has run. Under "loose" there is no sanitizing boundary there at
// all: the protection observed in testing was incidental, not declared.
check('mermaid securityLevel is not "loose"', !/securityLevel:\s*"loose"/.test(bundle));
check('mermaid securityLevel is "antiscript"', /securityLevel:\s*"antiscript"/.test(bundle));

// The planner's eight-payload suite, exercised end to end by termyard. Two payloads
// target mermaid specifically.
const suite = readFileSync(path.join(root, "test-fixtures/xss-suite.md"), "utf8");
const suiteHtml = await mod.renderMarkdownToHtml(suite, { docPath: "suite.md" });
// Assert on the markup OUTSIDE code elements. A fence legitimately CONTAINS the
// payload as escaped source text, and the fixture's own headings contain the words
// "javascript:" and "srcdoc", so a raw substring search reports leaks that are not
// there. Attribute-shaped patterns on the stripped markup is the real question.
const outsideCode = suiteHtml.replace(/<code[^>]*>[\s\S]*?<\/code>/g, "[fence]");
for (const [label, re] of [
  ["no event handler attributes", /\son[a-z]+=/i],
  ["no script elements", /<script/i],
  ["no javascript: in an attribute", /=["']\s*javascript:/i],
  ["no iframes", /<iframe/i],
  ["no srcdoc attribute", /srcdoc=/i],
  ["no payload markers survive as code", /window\.__P\d/],
]) {
  check("eight-payload suite: " + label, !re.test(outsideCode));
}
// The mermaid payloads must survive as INERT fence text, so the node view receives
// them as source rather than as markup.
check(
  "eight-payload suite: mermaid fences preserved as escaped text",
  /language-mermaid/.test(suiteHtml) && /&#x3C;img|&lt;img/.test(suiteHtml),
);

// ── 4. Stylesheet must not reach outside the viewer root ───────────────────
console.log("\nCSS containment");
const css = readFileSync(path.join(root, "dist/styles.css"), "utf8");
check("no :root palette", !css.includes(":root"));
check("no global reset", !/\*,:after,:before\{/.test(css));
check("no html/body rules", !/\}(html|body)\{/.test(css));
const hostReads = [...new Set([...css.matchAll(/var\((--(?!wv-|tw-)[a-z0-9-]+)/g)].map((m) => m[1]))];
const allowedReads = ["--background", "--foreground", "--editor-max-w", "--editor-ml", "--font-plex-mono"];
check(
  "reads only documented host tokens",
  hostReads.every((t) => allowedReads.includes(t)),
  hostReads.join(" "),
);

// ── 4b. Absence-testing: a class that was never emitted is invisible to every
//        other check here, since they all inspect what IS present. ───────────
console.log("\nCSS completeness");
const { used, missing } = findMissingClasses(css, path.join(root, "src"));
check(`all ${used.size} component classes present in CSS`, missing.length === 0, missing.slice(0, 8).join(" "));
check("arbitrary-value utility ships escaped", css.includes("." + escapeClassName("text-[13px]")));
check(
  "code renders monospace without preflight",
  /:where\(\.wv-viewer-root\) :is\(pre,code[^}]*font-family:var\(--wv-font-mono\)/.test(css),
);
check("--wv-font-mono resolves to a monospace stack", /--wv-font-mono:[^;]*monospace/.test(css));
check("source view font size ships", css.includes(".text-" + escapeClassName("[13px]")));


// ── 5. Syntax colours must clear WCAG AA on dark AND light hosts ───────────
console.log("\nContrast (WCAG AA 4.5:1 for body text)");
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
};
const oklabToLinear = (L, a, b) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};
const linearToOklab = (rgb) => {
  const [R, G, B] = rgb.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const oklch = (L) => oklabToLinear(L, 0, 0).map(linearToSrgb);
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
const mixOklab = (c1, p, c2) => {
  const a = linearToOklab(c1);
  const b = linearToOklab(c2);
  return oklabToLinear(...a.map((v, i) => v * p + b[i] * (1 - p))).map(linearToSrgb);
};
const over = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
const lum = (c) => {
  const [R, G, B] = c.map(srgbToLinear);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const block = css.match(/\.wv-viewer-root\{(.*?)\}/s);
if (!block) {
  check("token block present in shipped CSS", false);
} else {
  const decls = Object.fromEntries([...block[1].matchAll(/(--[a-z0-9-]+):([^;}]+)/g)].map((m) => [m[1], m[2]]));
  const resolve = (expr, host) => {
    const e = expr.trim();
    const v = e.match(/^var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)$/);
    if (v) {
      if (v[1] === "--foreground" || v[1] === "--background") return host[v[1]];
      if (decls[v[1]]) return resolve(decls[v[1]], host);
      if (v[2]) return resolve(v[2], host);
      throw new Error("unresolved " + v[1]);
    }
    const m = e.match(/^color-mix\(in oklab,\s*(.+?)\s+(\d+)%,\s*(.+)\)$/);
    if (m) {
      const a = resolve(m[1], host);
      const p = Number(m[2]) / 100;
      return m[3].trim() === "transparent" ? { alpha: p, colour: a } : mixOklab(a, p, resolve(m[3], host));
    }
    if (e.startsWith("#")) return hex(e);
    throw new Error("unparsed " + e);
  };
  const flat = (c, bg) => (c && c.alpha !== undefined ? over(c.colour, c.alpha, bg) : c);
  const hosts = {
    dark: { "--foreground": oklch(0.85), "--background": oklch(0.12) },
    light: { "--foreground": oklch(0.2), "--background": oklch(0.99) },
  };
  // Hue anchors must survive an ACHROMATIC host. Termyard's palette is entirely
  // oklch(L 0 0), chroma zero. If the syntax colours derived purely from
  // --foreground and --background they would collapse to greyscale: legible,
  // passing every ratio, and visually useless. The hardcoded hex anchors inside
  // --wv-success / --wv-warning / --wv-destructive are what prevent that, so this
  // asserts nobody can "simplify" them away.
  const achromatic = { "--foreground": oklch(0.85), "--background": oklch(0.12) };
  const spread = (c) => {
    const mean = (c[0] + c[1] + c[2]) / 3;
    return Math.max(...c.map((v) => Math.abs(v - mean))) * 255;
  };
  for (const token of ["--wv-code-string", "--wv-code-num", "--wv-code-danger"]) {
    const rgb = flat(resolve(decls[token], achromatic), oklch(0.15));
    check(`achromatic host: ${token} keeps hue`, spread(rgb) > 8, "channel spread " + spread(rgb).toFixed(1));
  }

  // .hljs-title must resolve to the foreground-weight token, not the amber one.
  // The artifact and the description disagreed here once and the reader was right
  // to call it: a legacy hljs-10 descendant selector made it look doubly declared.
  const titleRules = [...css.matchAll(/([^{}]*\.hljs-title[^{}]*)\{([^}]*)\}/g)];
  check("hljs-title declared", titleRules.length > 0);
  check(
    "every hljs-title rule binds --wv-code-fg",
    titleRules.every((m) => m[2].includes("--wv-code-fg")),
  );
  check("no unreachable legacy .hljs-class descendant", !css.includes(".hljs-class .hljs-title"));

  const CODE_TOKENS = ["--wv-code-fg", "--wv-code-dim", "--wv-code-string", "--wv-code-num", "--wv-code-type", "--wv-code-danger"];
  // Size and family are not visible to a contrast test, which is how an 11.05px
  // fence and a UA-default font survived every earlier gate.
  check(
    "fence body does not compound font-size",
    /\.tiptap pre code\{[^}]*font-size:1em/.test(css),
  );
  check(
    "fence sets font-family explicitly, not via the UA default",
    /\.tiptap pre\{[^}]*font-family:var\(--wv-font-mono\)/.test(css),
  );

  // Types shared a colour AND a weight with numeric literals, so six token classes
  // collapsed into four distinguishable ones.
  const typeColour = flat(resolve(decls["--wv-code-type"], hosts.dark), oklch(0.15));
  const numColour = flat(resolve(decls["--wv-code-num"], hosts.dark), oklch(0.15));
  const channelDelta = Math.max(...typeColour.map((v, i) => Math.abs(v - numColour[i]))) * 255;
  check("type and number are visually distinct", channelDelta > 24, "max channel delta " + channelDelta.toFixed(0));
  const typeSpread = spread(typeColour);
  check("achromatic host: --wv-code-type keeps hue", typeSpread > 8, "channel spread " + typeSpread.toFixed(1));


  console.log("  markdown fences, against the fence surface:");
  for (const [hostName, host] of Object.entries(hosts)) {
    const surface = flat(resolve(decls["--wv-code-bg"], host), host["--background"]);
    for (const token of CODE_TOKENS) {
      const r = ratio(flat(resolve(decls[token], host), surface), surface);
      check(`fence/${hostName}: ${token}`, r >= 4.5, r.toFixed(2) + ":1");
    }
  }

  // Source files are highlighted with the SAME tokens but sit on the page
  // background, with no fence surface behind them, so they need their own
  // measurement rather than inheriting the fence numbers.
  console.log("  source files, against the page background:");
  for (const [hostName, host] of Object.entries(hosts)) {
    const pageBg = flat(resolve(decls["--wv-background"], host), host["--background"]);
    for (const token of [...CODE_TOKENS, "--wv-muted-foreground"]) {
      const r = ratio(flat(resolve(decls[token], host), pageBg), pageBg);
      check(`source/${hostName}: ${token}`, r >= 4.5, r.toFixed(2) + ":1");
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join(", "));
  process.exit(1);
}
console.log("ALL INVARIANTS HOLD");
