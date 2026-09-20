/**
 * Icon-only controls must carry an accessible name.
 *
 * Found while driving the suggestion mode in a browser: the pencil that enters edit
 * mode is the ONLY way into it for a text file, and it was an icon-only <Button> with
 * no `title` or `aria-label`. So it was unnamed to assistive technology and invisible
 * to any name-based query — which is how the gap was noticed, when a lookup for the
 * mode toggle came back empty and the cause turned out to be upstream.
 *
 * Its sibling "Done editing" button already had a `title`, so this was an omission
 * rather than a convention. Two icon-only close buttons were missing one too.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();

/** Buttons whose entire content is a single self-closing icon element. */
function iconOnlyButtons(source: string) {
	// `[\s\S]` rather than the `s` flag: the project targets below es2018.
	const pattern = /<Button\b([\s\S]*?)>\s*(<[A-Z]\w* [^>]*\/>)\s*<\/Button>/g;
	const found: { line: number; icon: string; attrs: string }[] = [];
	for (const match of source.matchAll(pattern)) {
		found.push({
			line: source.slice(0, match.index).split("\n").length,
			icon: match[2].trim(),
			attrs: match[1],
		});
	}
	return found;
}

describe("icon-only buttons carry an accessible name", () => {
	const files = [
		"src/components/wiki/viewer-pane.tsx",
		// The editor and its comment surfaces, where an unlabelled control would be
		// equally invisible to a screen reader.
		"src/components/editor/editor.tsx",
		"src/components/editor/comment-margin.tsx",
		"src/components/editor/comment-thread.tsx",
	];

	for (const file of files) {
		test(`${file} names every icon-only button`, () => {
			const source = readFileSync(path.join(ROOT, file), "utf8");
			const unnamed = iconOnlyButtons(source).filter(
				(b) => !/\btitle=/.test(b.attrs) && !/\baria-label=/.test(b.attrs),
			);
			assert.deepEqual(
				unnamed.map((b) => `line ${b.line}: ${b.icon}`),
				[],
				"icon-only buttons need a title or aria-label",
			);
		});
	}

	test("the control that enters edit mode is named", () => {
		// Named specifically because it is the sole entry point to edit mode for a text
		// file: without a name it is unreachable to anyone not using a mouse.
		const source = readFileSync(
			path.join(ROOT, "src/components/wiki/viewer-pane.tsx"),
			"utf8",
		);
		const editBlock = source.slice(
			source.indexOf('title="Edit"'),
			source.indexOf('title="Edit"') + 320,
		);
		assert.match(editBlock, /setEditing\(true\)/, "this must be the edit control");
		assert.match(editBlock, /aria-label="Edit"/, "and it must be announced");
	});

	test("CONTROL: the auditor finds a button with no name", () => {
		// Guards against the regex quietly matching nothing and the suite passing for
		// the wrong reason.
		const sample = `<Button size="sm" onClick={f}><X className="h-3 w-3" /></Button>`;
		const found = iconOnlyButtons(sample);
		assert.equal(found.length, 1, "the auditor must recognise an icon-only button");
		assert.ok(
			!/title=|aria-label=/.test(found[0].attrs),
			"and must see that it has no name",
		);
	});
});
