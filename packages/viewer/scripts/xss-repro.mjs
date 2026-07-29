// XSS acceptance test. ORIGINAL FIXTURE BY THE PLANNER (session 019f936d), who
// wrote it after running the shipped bundle and finding that the DEFAULT markdown
// path emitted live event handlers and a script element. Vendored here verbatim,
// apart from this header and a repo-relative dist path, so the exact artifact that
// caught the bug stays in the repo and runs on every build.
//
// The lesson it encodes: renderMarkdownToHtml is a PUBLIC export, so the safe
// default belongs at the contract boundary. A consumer doing innerHTML = html is
// the obvious use of a function with that name, and must not be XSS'd for it.
// A green build, a passing typecheck and 60-document byte parity all sailed
// straight past this.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity } from "./artifact-identity.mjs";
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
console.log(artifactIdentity(path.dirname(DIST)));
const m = await import(DIST)

const evil = [
  '# heading survives',
  '',
  '<img src=x onerror="alert(1)">',
  '',
  '<script>alert(2)<\/script>',
  '',
  '<a href="javascript:alert(3)">link</a>',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
].join('\n')

const html = await m.renderMarkdownToHtml(evil)

const checks = {
  'onerror handler PRESENT': html.includes('onerror'),
  'script tag PRESENT': html.includes('<script'),
  'javascript: URL PRESENT': html.includes('javascript:'),
  'heading still rendered (must stay true)': html.includes('<h1'),
  'GFM table still rendered (must stay true)': html.includes('<table'),
}
for (const [k, v] of Object.entries(checks)) console.log((v ? 'YES ' : 'NO  ') + k)
console.log('\n--- emitted html ---\n' + html)

const unsafe = checks['onerror handler PRESENT'] || checks['script tag PRESENT'] || checks['javascript: URL PRESENT']
console.log('\nRESULT: ' + (unsafe ? 'UNSAFE, default path emits executable content' : 'SAFE, default path is sanitised'))
process.exit(unsafe ? 1 : 0)
