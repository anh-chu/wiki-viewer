/**
 * §7.6 Roundtrip fidelity: proof-span survives markdownToHtml → htmlToMarkdown.
 */
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";
import { ProofSpan } from "@/components/editor/extensions/proof-span";

const SPAN_TAG = "proof-span";

/** Collect all attribute key=value pairs from a proof-span tag in a string. */
function extractSpanAttrs(src: string): Map<string, string> {
	const match = src.match(/<proof-span\b([^>]*)>/);
	if (!match) return new Map();
	const attrsRaw = match[1];
	const map = new Map<string, string>();
	const attrRe = /([a-z-]+)="([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = attrRe.exec(attrsRaw)) !== null) {
		map.set(m[1], m[2]);
	}
	return map;
}

describe("editor-roundtrip proof-span", () => {
	it("preserves proof-span tag and inner content through html roundtrip", async () => {
		const md =
			'Hello <proof-span id="p123" origin="ai" by="ai:claude" at="2026-01-01T00:00:00Z" basis="described">hello world</proof-span> end.';

		const html = await markdownToHtml(md);

		// The HTML should contain a proof-span element (TipTap schema is client-side;
		// here we verify the remark pipeline preserves raw HTML passthrough).
		assert.ok(html.includes(SPAN_TAG), `HTML should contain <${SPAN_TAG}> tag:\n${html}`);
		assert.ok(html.includes("hello world"), "HTML should contain inner text");

		const roundtripped = htmlToMarkdown(html);

		assert.ok(
			roundtripped.includes(`<${SPAN_TAG}`),
			`Roundtripped markdown should contain <${SPAN_TAG}> tag:\n${roundtripped}`,
		);
		assert.ok(
			roundtripped.includes("hello world"),
			"Roundtripped markdown should contain inner text",
		);

		const origAttrs = extractSpanAttrs(md);
		const rtAttrs = extractSpanAttrs(roundtripped);

		// Every attr in the original must survive the roundtrip.
		for (const [key, value] of origAttrs) {
			assert.equal(
				rtAttrs.get(key),
				value,
				`Attribute '${key}' should survive roundtrip. Expected '${value}', got '${rtAttrs.get(key)}'`,
			);
		}
	});

	it("TipTap ProofSpan mark schema matches spec", () => {
		const inst = ProofSpan.configure({});
		assert.equal(inst.name, "proofSpan");
		const spec = (inst as { config: { parseHTML?: () => unknown[] } }).config;
		assert.ok(spec.parseHTML, "parseHTML defined");
		const parseRules = (spec.parseHTML as () => Array<{ tag: string }>)();
		assert.equal(parseRules[0].tag, "proof-span");
	});

	it("preserves proof-span with wiki-link child", async () => {
		const md =
			'Text <proof-span id="p456" origin="ai" by="ai:cursor" at="2026-01-01T00:00:00Z" basis="inferred">see [[my-page]]</proof-span>.';

		const html = await markdownToHtml(md);
		const roundtripped = htmlToMarkdown(html);

		assert.ok(roundtripped.includes(`<${SPAN_TAG}`), "span tag preserved");
		// Wiki-link should be preserved (either as [[my-page]] or as anchor markup)
		assert.ok(
			roundtripped.includes("my-page"),
			"wiki-link slug preserved inside span",
		);
	});
});
