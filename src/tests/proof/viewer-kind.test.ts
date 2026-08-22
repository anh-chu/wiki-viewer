import assert from "node:assert/strict";
import test from "node:test";

import { viewerKindFor } from "../../lib/viewer-kind.js";

test("viewerKindFor maps .excalidraw files to canvas", () => {
	assert.equal(viewerKindFor("diagram.excalidraw", "file"), "canvas");
	assert.equal(viewerKindFor("nested/diagram.EXCALIDRAW", "file"), "canvas");
});
