import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { carbonizeLiveVariant } from "../../lib/proof/live/carbonize";

function hash(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

const forbidden = [
	"impeccable-variants-start",
	"impeccable-variants-end",
	"impeccable-carbonize-start",
	"impeccable-carbonize-end",
	"impeccable-param-values",
	"data-impeccable-",
	"data-p-",
	"var(--p-",
	"--impeccable-variant-ready",
];

test("carbonizes chosen live variant, bakes params, and preserves surrounding source", () => {
	const before = "<header>Keep before</header>\n";
	const after = "\n<footer>Keep after</footer>\n";
	const source = `${before}<!-- impeccable-carbonize-start sess-1 -->
<style data-impeccable-css="sess-1">
@scope ([data-impeccable-variant="2"]) {
  .choice[data-p-size="large"] { font-size: var(--p-size, 1rem); }
  .choice[data-p-size="small"] { font-size: 0.75rem; }
}
.ready { --impeccable-variant-ready: 1; color: var(--p-color); }
</style>
<!-- impeccable-param-values sess-1: {"size":"large","color":"rebeccapurple"} -->
<!-- impeccable-carbonize-end sess-1 -->
<div data-impeccable-variant="1" style="display: contents"><p class="choice" data-p-size="small">Discard</p></div>
<div data-impeccable-variant="2" style="display: contents"><p class="choice" data-p-size="large" data-impeccable-picked="yes" style="color: var(--p-color)">Chosen</p></div>${after}`;

	const result = carbonizeLiveVariant({
		source,
		baseHash: hash(source),
		chosenVariantId: "2",
		paramValues: { size: "large", color: "rebeccapurple" },
	});

	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.source.slice(0, before.length), before);
	assert.equal(result.source.slice(-after.length), after);
	for (const token of forbidden) assert.equal(result.source.includes(token), false, token);
	assert.match(result.source, /<p[^>]*>Chosen<\/p>/);
	assert.equal(result.source.includes("Discard"), false);
	assert.match(result.source, /font-size: large;/);
	assert.equal(result.source.includes("font-size: 0.75rem"), false);
});

test("bakes param values containing $-replacement patterns literally (F1)", () => {
	const source = `<!-- impeccable-carbonize-start s -->
<!-- impeccable-carbonize-end s -->
<div data-impeccable-variant="1" style="display: contents"><p class="c">{{ p-label }}</p></div>`;
	for (const value of ["$&", "$`", "$'", "$$", "a$1b"]) {
		const result = carbonizeLiveVariant({
			source,
			baseHash: hash(source),
			chosenVariantId: "1",
			paramValues: { label: value },
		});
		assert.equal(result.ok, true, value);
		if (!result.ok) return;
		assert.match(result.source, new RegExp(`<p class="c">${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`), value);
		assert.equal(result.source.includes("{{ p-label }}"), false, `scaffolding remained for ${value}`);
	}
});

test("refuses base drift without transforming source", () => {
	const source = "<!-- impeccable-carbonize-start sess -->\n<!-- impeccable-carbonize-end sess -->";
	const result = carbonizeLiveVariant({
		source,
		baseHash: hash(`${source}!`),
		chosenVariantId: "1",
		paramValues: {},
	});

	assert.deepEqual(result, { ok: false, code: "BASE_DRIFT" });
});

test("reports missing markers and missing chosen variant", () => {
	const noMarkers = carbonizeLiveVariant({
		source: "<main>plain</main>",
		baseHash: hash("<main>plain</main>"),
		chosenVariantId: "1",
		paramValues: {},
	});
	assert.deepEqual(noMarkers, { ok: false, code: "NO_MARKERS" });

	const source = "<!-- impeccable-carbonize-start sess -->\n<!-- impeccable-carbonize-end sess -->\n<div data-impeccable-variant=\"1\">One</div>";
	const noVariant = carbonizeLiveVariant({
		source,
		baseHash: hash(source),
		chosenVariantId: "2",
		paramValues: {},
	});
	assert.equal(noVariant.ok, false);
	if (noVariant.ok) return;
	assert.equal(noVariant.code, "NO_VARIANT");
});
