// Independent adversarial probe. ORIGINAL BY THE PLANNER (session 019f936d), who
// wrote it rather than reusing this package's own vector list, on the grounds that
// a list can only test what its author already thought of. It caught five vectors
// that were not on ours: data:text/html hrefs, svg onload, base href, meta refresh
// and external stylesheet links. Vendored verbatim apart from this header and a
// repo-relative dist path.
//
// One further addition, per the planner's own request: the build stamp is printed
// first, so any pasted result is attributable to a specific artifact.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp } from "./artifact-identity.mjs";
console.log(buildStamp(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist")));
// Independent hostile-fixture probe. Does not reuse wiki-viewer's test list.
// Run: node /tmp/tyverify/hostile-probe.mjs
const m = await import('../dist/index.js')

const md = [
  '# doc',
  '',
  '<script>alert(1)<\/script>',
  '<img src=x onerror="alert(2)">',
  '<div onclick="alert(3)">c</div>',
  '<svg onload="alert(4)"></svg>',
  '<a href="javascript:alert(5)">js</a>',
  '<a href="vbscript:alert(6)">vb</a>',
  '<a href="data:text/html,<script>alert(7)<\/script>">data</a>',
  '<iframe src="https://evil.example.com/phish"></iframe>',
  '<object data="x.swf"></object>',
  '<embed src="x.swf">',
  '<form action="https://evil.example.com"><input name=pw></form>',
  '<div style="background:url(javascript:alert(8))">s</div>',
  '<math><mtext><script>alert(9)<\/script></mtext></math>',
  '<base href="https://evil.example.com/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example.com">',
  '<link rel="stylesheet" href="https://evil.example.com/x.css">',
  '<a href="https://ok.example.com" target="_blank">ok link</a>',
  '',
  '- [ ] task item',
  '- [x] done item',
  '',
  '```go',
  'func main() {}',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
].join('\n')

const html = await m.renderMarkdownToHtml(md)

const mustBlock = {
  'script tag': /<script/i,
  'onerror': /onerror/i,
  'onclick': /onclick/i,
  'onload': /onload/i,
  'javascript: url': /javascript:/i,
  'vbscript: url': /vbscript:/i,
  'data:text/html url': /data:text\/html/i,
  'foreign iframe': /evil\.example\.com/i,
  'object tag': /<object/i,
  'embed tag': /<embed/i,
  'form tag': /<form/i,
  'base tag': /<base/i,
  'meta refresh': /<meta/i,
  'external stylesheet link': /<link/i,
}
const mustKeep = {
  'h1 heading': /<h1/i,
  'GFM table': /<table/i,
  'language-go fence': /language-go/i,
  'task list markup': /task-list|checkbox|type="checkbox"/i,
  'benign external link': /ok\.example\.com/i,
}

let leaks = 0, lost = 0
console.log('--- MUST BLOCK ---')
for (const [k, re] of Object.entries(mustBlock)) {
  const hit = re.test(html)
  if (hit) leaks++
  console.log((hit ? 'LEAK    ' : 'blocked ') + k)
}
console.log('\n--- MUST KEEP ---')
for (const [k, re] of Object.entries(mustKeep)) {
  const hit = re.test(html)
  if (!hit) lost++
  console.log((hit ? 'kept    ' : 'LOST    ') + k)
}
console.log(`\nleaks=${leaks} lost=${lost} -> ` + (leaks === 0 && lost === 0 ? 'PASS' : 'FAIL'))
console.log('\n--- emitted html ---\n' + html)
process.exit(leaks === 0 && lost === 0 ? 0 : 1)
