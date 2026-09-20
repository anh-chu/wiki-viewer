/**
 * The two-way link between a comment in the text and its card in the panel.
 *
 * Clicking either end has to light the other, and "active" has to be a real,
 * persistent state rather than a reuse of hover. The reason is concrete: the
 * reader hovers a card to find its text, then moves the pointer INTO the panel to
 * type a reply — at which point a hover-only highlight vanishes exactly when it
 * is being used.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const EDITOR = readFileSync(
	new URL("../../components/editor/editor.tsx", import.meta.url),
	"utf8",
);
const HIGHLIGHT = readFileSync(
	new URL("../../components/editor/extensions/comment-highlight.ts", import.meta.url),
	"utf8",
);
const MARGIN = readFileSync(
	new URL("../../components/editor/comment-margin.tsx", import.meta.url),
	"utf8",
);
const CSS = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

describe("the text and the panel highlight each other", () => {
	test("the text decoration carries an active state, not just hover", () => {
		assert.match(
			HIGHLIGHT,
			/"data-active": activeRef === ref/,
			"the decoration must expose which comment is active",
		);
	});

	test("the decoration handler reports the clicked comment", () => {
		// Read from the decoration's own attribute rather than from the clicked
		// position, so the id cannot disagree with the range it was drawn for.
		assert.match(HIGHLIGHT, /data-comment-id/);
		assert.match(HIGHLIGHT, /getState\(\)\.onSelectRef\?\.\(id\)/);
	});

	test("clicking the text opens the panel on its comments tab", () => {
		// The reader asked for a comment; a Changes tab would hide the card they
		// clicked for, making the click appear to do nothing.
		const handler = EDITOR.slice(
			EDITOR.indexOf("Clicking a highlighted comment in the TEXT"),
			EDITOR.indexOf("selectCommentByRefRef.current = selectCommentByRef"),
		);
		assert.ok(handler.length > 0, "expected the selection handler");
		assert.match(handler, /revealComments\(\)/, "it must surface the panel");
		assert.match(handler, /setActiveMarginRefNow\(blockRef\)/, "and open that card");
	});

	test("the click resolves the comment id through the SAME view the decorator used", () => {
		// `comment.ref` can name a block that no longer exists; the resolved view is
		// this document's answer. Using the raw ref would open the wrong card, or none.
		const handler = EDITOR.slice(
			EDITOR.indexOf("Clicking a highlighted comment in the TEXT"),
			EDITOR.indexOf("selectCommentByRefRef.current = selectCommentByRef"),
		);
		assert.match(handler, /commentViews\?\.\[commentId\]/);
		assert.match(handler, /view\?\.ref \?\? comment\?\.ref/);
	});

	test("the active ref reaches both the decorator and the panel", () => {
		// One value, two readers: if the panel read its own state the two ends could
		// show different comments as active.
		assert.match(EDITOR, /activeRef: activeMarginRef/, "the decorator reads it");
		assert.match(EDITOR, /activeRef=\{activeMarginRef\}/, "so does the panel");
	});

	test("activating from the text scrolls the card into view", () => {
		// The panel does not scroll with the document, so a card opened from a click in
		// the text can be off-screen. Without this the click appears to do nothing.
		assert.match(MARGIN, /scrollIntoView\(\{ behavior: "smooth", block: "nearest" \}\)/);
		assert.match(
			MARGIN,
			/\}, \[activeRef\]\);/,
			"keyed on activeRef, so it fires on activation rather than on every render",
		);
	});

	test("the card carries the active flag for styling", () => {
		assert.match(
			MARGIN,
			/data-active=\{\s*card\.thread/,
			"the card wrapper must expose which card is active",
		);
	});
});

describe("active and hover are different states", () => {
	test("active persists without hover", () => {
		// The whole point: an active-but-not-hovered comment must still read as
		// selected. A rule keyed on both attributes would fail this.
		const activeOnly = CSS.slice(CSS.indexOf('.comment-highlight[data-active="true"] {'));
		const rule = activeOnly.slice(0, activeOnly.indexOf("}"));
		assert.ok(rule.length > 0, "expected an active-only rule");
		assert.match(rule, /background-color/, "it must style on its own");
		assert.ok(
			!/data-hovered/.test(rule.split("{")[0]),
			"the active rule must not also require hover",
		);
	});

	test("active is stronger than hover, so an active card is unmistakable", () => {
		const pct = (selector: string) => {
			const at = CSS.indexOf(selector);
			assert.ok(at > 0, `expected to find ${selector}`);
			const rule = CSS.slice(at, CSS.indexOf("}", at));
			const m = rule.match(/background-color:[^;]*?(\d+)%/);
			assert.ok(m, `expected a background percentage in ${selector}`);
			return Number(m[1]);
		};
		const hovered = pct('.comment-highlight[data-hovered="true"] {');
		const active = pct('.comment-highlight[data-active="true"] {');
		assert.ok(
			active > hovered,
			`active (${active}%) must be stronger than hover (${hovered}%)`,
		);
	});

	test("hovering the active comment is not a third, weaker state", () => {
		// Without this the comment would appear to DE-highlight on hover: the specific
		// hover rule would win over the general active rule and drop the intensity.
		assert.match(
			CSS,
			/\.comment-highlight\[data-active="true"\]\[data-hovered="true"\]/,
		);
	});
});