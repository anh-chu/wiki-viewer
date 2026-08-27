import assert from "node:assert/strict";
import test from "node:test";

import { viewerKindFor } from "../../lib/viewer-kind.js";

test("viewerKindFor maps .excalidraw files to canvas", () => {
	assert.equal(viewerKindFor("diagram.excalidraw", "file"), "canvas");
	assert.equal(viewerKindFor("nested/diagram.EXCALIDRAW", "file"), "canvas");
});

test("viewerKindFor maps .mdx to the mdx viewer, .md stays editor", () => {
	assert.equal(viewerKindFor("doc.mdx", "file"), "mdx");
	assert.equal(viewerKindFor("nested/Doc.MDX", "file"), "mdx");
	assert.equal(viewerKindFor("doc.md", "file"), "editor");
	assert.equal(viewerKindFor("doc.markdown", "file"), "editor");
});
