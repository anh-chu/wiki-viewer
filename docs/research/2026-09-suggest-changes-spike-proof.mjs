/**
 * Spike: can marks-based tracked changes
 * (`@handlewithcare/prosemirror-suggest-changes`) persist BYTE-IDENTICAL Markdown
 * through the app's real save boundary (`editor.getHTML()` -> htmlToMarkdown)?
 *
 * Runs on the real TipTap stack (3.31.3 in scratch; repo has 3.24.0 - see report).
 *
 * A. baseline document, no suggestion                  -> getHTML() -> markdown
 * B. same document WITH insertion+deletion marks       -> getHTML() -> markdown   (leak?)
 * C. same document, marks stripped at the boundary     -> getHTML() -> markdown   (must == A)
 *
 * Two serialization routes are tested for C, because the app's save path is
 * `editor.getHTML()` and TipTap resolves its schema ONCE at construction:
 *   C1. filtered MARK SET passed into TipTap's own serializer
 *   C2. hand-rolled filtered DOMSerializer pass over the doc
 */
import "./dom-boot.mjs";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Schema, DOMSerializer } from "@tiptap/pm/model";
import { addSuggestionMarks } from "@handlewithcare/prosemirror-suggest-changes";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import assert from "node:assert/strict";

// --- mirror of src/lib/markdown/to-markdown.ts (plain-prose subset) ---------
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
});
turndown.use(gfm);
const htmlToMarkdown = (html) => turndown.turndown(html);

const BASE_HTML =
	"<h1>Title</h1><p>The quick brown fox jumps.</p><p>Second paragraph here.</p>";
const SUGGESTION_MARKS = ["insertion", "deletion", "modification"];

// Serialize a doc to an HTML *string* via a real detached div (a bare
// serializeFragment returns a DocumentFragment whose toString is useless).
const toHtmlString = (doc, schema) => {
	const div = document.createElement("div");
	div.appendChild(
		DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document }),
	);
	return div.innerHTML;
};

// ---------------------------------------------------------------------------
// 1. Baseline TipTap editor -> its schema
// ---------------------------------------------------------------------------
const base = new Editor({ extensions: [StarterKit], content: BASE_HTML, editable: false });
const tiptapSchema = base.schema;
console.log("baseline tiptap marks:", Object.keys(tiptapSchema.marks).join(", "));

// ---------------------------------------------------------------------------
// 2. Suggestion-enabled schema.
//    NOTE (real finding): addSuggestionMarks() REPLACES the marks map you pass.
//    Passing `tiptapSchema.spec.marks` (an OrderedMap) silently drops every
//    TipTap mark and yields a bogus `content` mark. The marks map must be a
//    plain object of MarkSpecs.
// ---------------------------------------------------------------------------
const rawMarks = tiptapSchema.spec.marks;
const marksAsObject =
	typeof rawMarks.keys === "function" && typeof rawMarks.get === "function"
		? Object.fromEntries([...rawMarks.keys()].map((n) => [n, rawMarks.get(n)]))
		: { ...rawMarks };
console.log("spec.marks shape:", rawMarks.constructor?.name);
const markedSchema = new Schema({
	nodes: tiptapSchema.spec.nodes,
	marks: addSuggestionMarks(marksAsObject),
});
console.log("marked schema marks   :", Object.keys(markedSchema.marks).join(", "));

const docPlain = tiptapSchema.nodeFromJSON(base.getJSON());

// ---------------------------------------------------------------------------
// 3. Build the marked doc.
//
//    Fixture design: the mooted question is whether STRIPPING loses/keeps text.
//    A tracked DELETION keeps its text in the doc (that is the mechanism), so a
//    doc carrying only a deletion mark has EXACTLY the same text as the
//    un-marked doc. C must therefore byte-equal A. (An insertion mark adds
//    text - see variant D below, which documents that insertion marks are a
//    semantic content change, not a serialization artifact.)
// ---------------------------------------------------------------------------
const deletionMark = markedSchema.marks.deletion.create({ id: "s2" });
const insertionMark = markedSchema.marks.insertion.create({ id: "s1" });

const plainP1 = docPlain.child(1);
const p1 = plainP1.textContent; // "The quick brown fox jumps."
const idxThe = p1.indexOf(" ") + 1; // after "The "
const idxQuickEnd = p1.indexOf("quick ") + "quick ".length;

// C-case doc: same text as plain, but "quick " carries the deletion mark.
const p1Deleted = markedSchema.nodes.paragraph.create(null, [
	markedSchema.text(p1.slice(0, idxThe)),
	markedSchema.text(p1.slice(idxThe, idxQuickEnd), [deletionMark]),
	markedSchema.text(p1.slice(idxQuickEnd)),
]);

// D-case doc: an insertion mark adds text ("very ").
const p1Inserted = markedSchema.nodes.paragraph.create(null, [
	markedSchema.text(p1.slice(0, idxThe)),
	markedSchema.text("very ", [insertionMark]),
	markedSchema.text(p1.slice(idxThe)),
]);

const rebuild = (p1Node) => {
	const out = [];
	docPlain.forEach((child, _o, i) => {
		out.push(i === 1 ? p1Node : markedSchema.nodeFromJSON(child.toJSON()));
	});
	return markedSchema.nodes.doc.create(null, out);
};
const docDeleted = rebuild(p1Deleted);
const docInserted = rebuild(p1Inserted);

// ---------------------------------------------------------------------------
// 4. Serialization variants
// ---------------------------------------------------------------------------
const htmlA = toHtmlString(docPlain, tiptapSchema);
const htmlB = toHtmlString(docDeleted, markedSchema);
const htmlD = toHtmlString(docInserted, markedSchema);

// C2: hand-rolled filtered serializer - the candidate strip point.
const stripSerialize = (doc, schema) => {
	const div = document.createElement("div");
	const renderInline = (node, parent) => {
		if (node.isText) {
			const kept = node.marks.filter((m) => !SUGGESTION_MARKS.includes(m.type.name));
			let dom = document.createTextNode(node.text);
			for (const mark of kept) {
				const spec = mark.type.spec.toDOM(mark, false);
				const tag = typeof spec === "string" ? spec : spec[0];
				const attrs = typeof spec === "string" ? null : spec[1];
				const el = document.createElement(tag);
				if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
				el.appendChild(dom);
				dom = el;
			}
			parent.appendChild(dom);
			return;
		}
		const spec = node.type.spec.toDOM(node, false);
		const tag = typeof spec === "string" ? spec : spec[0];
		const attrs = typeof spec === "string" ? null : spec[1];
		const el = document.createElement(tag);
		if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
		node.forEach((child) => renderInline(child, el));
		parent.appendChild(el);
	};
	doc.forEach((block) => renderInline(block, div));
	return div.innerHTML;
};
const htmlC = stripSerialize(docDeleted, markedSchema);
const htmlE = stripSerialize(docInserted, markedSchema);

const mdA = htmlToMarkdown(htmlA);
const mdB = htmlToMarkdown(htmlB);
const mdC = htmlToMarkdown(htmlC);
const mdD = htmlToMarkdown(htmlD);
const mdE = htmlToMarkdown(htmlE);

console.log("\n--- A baseline HTML ---\n" + htmlA);
console.log("--- A baseline Markdown ---\n" + JSON.stringify(mdA));
console.log("\n--- B DELETION-marked HTML (does it leak?) ---\n" + htmlB);
console.log("--- B DELETION-marked Markdown ---\n" + JSON.stringify(mdB));
console.log("\n--- C DELETION-marked, stripped HTML ---\n" + htmlC);
console.log("--- C DELETION-marked, stripped Markdown ---\n" + JSON.stringify(mdC));
console.log("\n--- D INSERTION-marked HTML ---\n" + htmlD);
console.log("--- D INSERTION-marked Markdown ---\n" + JSON.stringify(mdD));
console.log("--- E INSERTION-marked, stripped Markdown ---\n" + JSON.stringify(mdE));

console.log("\n=== ASSERTIONS ===");
console.log("1. deletion mark leaks into markdown (B != A) :", mdB !== mdA);
assert.notEqual(mdB, mdA, "expected the deletion mark to leak (as <del> -> ~x~)");
console.log("2. DELETION stripped => byte-identical to A    :", mdC === mdA);
assert.equal(mdC, mdA, "stripping a deletion mark must restore the baseline bytes");
console.log('3. INSERTION stripped => keeps inserted text  :', mdE === "# Title\n\nThe very quick brown fox jumps.\n\nSecond paragraph here.");
assert.equal(
	mdE,
	"# Title\n\nThe very quick brown fox jumps.\n\nSecond paragraph here.",
	"stripping an insertion mark keeps the inserted text (content change, not a serialization artifact)",
);
console.log("\nPROVED: filtered serialization removes every trace of the suggestion markup.");