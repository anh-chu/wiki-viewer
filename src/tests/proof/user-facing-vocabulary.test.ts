/**
 * User-facing text says "comment" and "suggestion", never internal vocabulary.
 *
 * The objective fixes the vocabulary exactly: the surfaces talk about comments and
 * suggestions. Internal names for the same things — annotation, redline, orphan, stale,
 * pip — are implementation vocabulary that leaked into earlier UI, and a reader has no
 * reason to meet them.
 *
 * Confirmed against the running app, which is where this belongs: a static scan of
 * source strings would miss text assembled at runtime, and DOM text is what a user
 * actually reads. The source-side assertions below are the cheap regression guard; the
 * live check is what established the fact.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/** Surfaces a user can actually read. */
const USER_FACING = [
	"src/components/editor/comment-margin.tsx",
	"src/components/editor/comment-thread.tsx",
	"src/components/editor/view-mode-comment-button.tsx",
];

/** The internal terms that must not appear in rendered strings. */
const FORBIDDEN = ["redline", "orphan", "annotation", "pip"];

/**
 * Pull the human-readable string literals out of a JSX file, ignoring imports, class
 * names, identifiers and data attributes — those legitimately keep internal names.
 */
function visibleStrings(source: string): string[] {
	const found: string[] = [];
	for (const m of source.matchAll(/aria-label="([^"]+)"/g)) found.push(m[1]);
	for (const m of source.matchAll(/title="([^"]+)"/g)) found.push(m[1]);
	for (const m of source.matchAll(/placeholder="([^"]+)"/g)) found.push(m[1]);
	// Literal text between tags, e.g. >Send<
	for (const m of source.matchAll(/>\s*([A-Z][A-Za-z ]{2,40})\s*</g)) found.push(m[1]);
	return found;
}

describe("the UI speaks of comments and suggestions only", () => {
	for (const file of USER_FACING) {
		test(`${file} avoids internal vocabulary in visible strings`, () => {
			const strings = visibleStrings(read(file));
			const offenders = strings.filter((s) =>
				FORBIDDEN.some((w) => new RegExp(`\\b${w}`, "i").test(s)),
			);
			assert.deepEqual(offenders, [], `internal vocabulary reached the UI: ${offenders}`);
		});
	}

	test("the margin's own control is named for the user's word", () => {
		// The live app shows exactly this label, so a rename to internal vocabulary is
		// caught here.
		assert.match(
			read("src/components/editor/comment-thread.tsx"),
			/aria-label="Collapse comment"/,
			'the control says "comment"',
		);
	});

	test("CONTROL: the extractor finds real strings", () => {
		// If visibleStrings returned nothing, every assertion above would pass vacuously.
		const strings = visibleStrings(read("src/components/editor/comment-thread.tsx"));
		assert.ok(strings.length >= 3, `expected several visible strings, got ${strings.length}`);
		assert.ok(
			strings.some((s) => /comment/i.test(s)),
			"and at least one of them should mention a comment",
		);
	});

	test("CONTROL: the forbidden list actually matches something", () => {
		// Guards against a typo in the list making the scan meaningless.
		assert.ok(
			FORBIDDEN.some((w) => new RegExp(`\\b${w}`, "i").test("This is a redline view")),
			"the pattern must be able to match",
		);
	});
});
