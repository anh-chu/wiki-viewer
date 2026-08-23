import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const componentPath = path.join(
	process.cwd(),
	"src/components/editor/view-mode-comment-button.tsx",
);
const editorPath = path.join(process.cwd(), "src/components/editor/editor.tsx");
const popoverPath = path.join(
	process.cwd(),
	"src/components/editor/suggest-edit-popover.tsx",
);

test("view mode toolbar exposes Suggest beside Comment", async () => {
	const component = await readFile(componentPath, "utf8");
	const editor = await readFile(editorPath, "utf8");

	assert.match(component, /onSuggest\?: \(\) => void/);
	assert.match(component, /<span>Suggest<\/span>/);
	assert.match(component, /onClick=\{\(\) => \{/);
	assert.match(component, /onSuggest\(\);/);
	assert.match(component, /\[@media\(pointer:coarse\)\]:min-h-11/);
	assert.match(component, /onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/);

	assert.match(
		editor,
		/\{isViewing && \(\s*<ViewModeCommentButton[\s\S]*?onComment=\{openCommentForSelection\}[\s\S]*?onSuggest=\{openSuggestForSelection\}/,
	);
});

test("view mode Suggest uses the existing human sidecar suggestion path", async () => {
	const popover = await readFile(popoverPath, "utf8");

	assert.match(popover, /wsFetch\(`\/api\/agent\/files\/\$\{encoded\}`/);
	assert.match(popover, /by: "human"/);
	assert.match(popover, /type: "suggestion\.add"/);
	assert.match(popover, /onKeyDown=\{\(e\) => \{/);
	assert.match(popover, /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)/);
});
