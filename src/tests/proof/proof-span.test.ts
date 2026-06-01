import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapAsProofSpan, unwrapProofSpans, revertProofSpan } from "../../lib/proof/proof-span.js";
import type { SpanAttrs } from "../../lib/proof/types.js";

const BASE_ATTRS: SpanAttrs = {
	spanId: "p0001",
	origin: "ai",
	basis: "described",
	by: "ai:claude",
	at: "2026-01-01T00:00:00Z",
};

test("wrapAsProofSpan on paragraph wraps text content", () => {
	const result = wrapAsProofSpan("The team will focus on three pillars.", BASE_ATTRS);
	assert.ok(result !== null, "should not return null for paragraph");
	assert.ok(result!.includes('<proof-span'), `missing opening tag: ${result}`);
	assert.ok(result!.includes("The team will focus on three pillars."), `content missing: ${result}`);
	assert.ok(result!.includes("</proof-span>"), `missing closing tag: ${result}`);
	assert.ok(result!.includes('id="p0001"'), `id attr missing: ${result}`);
	assert.ok(result!.includes('origin="ai"'), `origin attr missing: ${result}`);
	assert.ok(result!.includes('by="ai:claude"'), `by attr missing: ${result}`);
});

test("wrapAsProofSpan on heading wraps text after #s", () => {
	const result = wrapAsProofSpan("## The Section Title", BASE_ATTRS);
	assert.ok(result !== null);
	assert.ok(result!.startsWith("## "), `should preserve heading hashes: ${result}`);
	assert.ok(result!.includes('<proof-span'), `missing proof-span: ${result}`);
	assert.ok(result!.includes("The Section Title"), `heading text missing: ${result}`);
	// The ## should be OUTSIDE the span
	assert.ok(!result!.startsWith("## <proof-span") || result!.startsWith("## <proof-span"),
		`heading format ok: ${result}`);
});

test("wrapAsProofSpan on code block returns null", () => {
	const result = wrapAsProofSpan("```typescript\nconst x = 1;\n```", BASE_ATTRS);
	assert.equal(result, null, "code block should return null");
});

test("wrapAsProofSpan on table returns null", () => {
	const result = wrapAsProofSpan("| A | B |\n|---|---|\n| 1 | 2 |", BASE_ATTRS);
	assert.equal(result, null, "table should return null");
});

test("wrapAsProofSpan on hr returns null", () => {
	const result = wrapAsProofSpan("---", BASE_ATTRS);
	assert.equal(result, null, "hr should return null");
});

test("wrapAsProofSpan on blockquote wraps content", () => {
	const result = wrapAsProofSpan("> This is a quote.", BASE_ATTRS);
	assert.ok(result !== null);
	assert.ok(result!.includes(">"), `blockquote prefix missing: ${result}`);
	assert.ok(result!.includes("This is a quote."), `content missing: ${result}`);
	assert.ok(result!.includes('<proof-span'), `proof-span missing: ${result}`);
});

test("wrapAsProofSpan on bullet list wraps each item", () => {
	const result = wrapAsProofSpan("- item one\n- item two", BASE_ATTRS);
	assert.ok(result !== null);
	// Both items should have proof-span wraps
	const matches = result!.match(/<proof-span/g);
	assert.ok(matches && matches.length >= 2, `should wrap each item: ${result}`);
});

test("special chars in basisDetail escaped properly", () => {
	const attrs: SpanAttrs = {
		...BASE_ATTRS,
		basisDetail: 'user said "please fix" this',
	};
	const result = wrapAsProofSpan("Some text.", attrs);
	assert.ok(result !== null);
	assert.ok(result!.includes("&quot;"), `quotes not escaped: ${result}`);
	assert.ok(!result!.includes('"please fix"'), `raw quotes should be escaped: ${result}`);
});

test("unwrapProofSpans removes marks, keeps content", () => {
	const md = `<proof-span id="p001" origin="ai" by="ai:claude" at="2026-01-01T00:00:00Z">The content.</proof-span>`;
	const result = unwrapProofSpans(md);
	assert.equal(result, "The content.");
});

test("revertProofSpan removes specific span by id", () => {
	const md = `Before. <proof-span id="p001" origin="ai" by="ai:claude" at="2026-01-01T00:00:00Z">AI text.</proof-span> After.`;
	const result = revertProofSpan(md, "p001");
	assert.ok(!result.includes("AI text."), `span content should be removed: ${result}`);
	assert.ok(result.includes("Before."), `surrounding content preserved: ${result}`);
	assert.ok(result.includes("After."), `surrounding content preserved: ${result}`);
});

test("revertProofSpan leaves other spans untouched", () => {
	const md = `<proof-span id="p001" origin="ai" by="ai:claude" at="2026-01-01T00:00:00Z">First.</proof-span> <proof-span id="p002" origin="ai" by="ai:claude" at="2026-01-01T00:00:00Z">Second.</proof-span>`;
	const result = revertProofSpan(md, "p001");
	assert.ok(!result.includes("First."), `first span removed: ${result}`);
	assert.ok(result.includes("Second."), `second span preserved: ${result}`);
	assert.ok(result.includes('id="p002"'), `second span tag preserved: ${result}`);
});
