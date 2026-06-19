import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeName } from "../../lib/humanize-name.js";

test("humanizeName: case styles, acronyms, extensions", () => {
	assert.equal(humanizeName("API_v2_config.md"), "API V2 Config.md");
	assert.equal(humanizeName("getUserData.ts"), "Get User Data.ts");
	assert.equal(humanizeName("parseHTMLString.js"), "Parse HTML String.js");
	assert.equal(humanizeName("my-notes.md"), "My Notes.md");
	assert.equal(humanizeName("folder_name"), "Folder Name");
	assert.equal(humanizeName("README.md"), "README.md");
	assert.equal(humanizeName(".gitignore"), ".gitignore");
	assert.equal(humanizeName("2024-notes.md"), "2024 Notes.md");
});
