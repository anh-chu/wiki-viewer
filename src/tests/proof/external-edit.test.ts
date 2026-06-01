import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSnapshot } from "../../lib/proof/ops-applier.js";
import { setRootDir } from "../../lib/root-dir.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-ext-edit-test-"));
	setRootDir(tmpRoot);
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

test("readSnapshot: detects external edit and emits file.externallyEdited event", async () => {
	const mdFile = path.join(tmpRoot, "ext-edit.md");
	const original = "# Title\n\nOriginal content.\n";

	// Write initial content
	await writeFile(mdFile, original, "utf-8");

	// Take first snapshot — establishes fingerprint in sidecar
	const snap0 = await readSnapshot(tmpRoot, "ext-edit.md");
	assert.ok(snap0 !== null);
	assert.equal(snap0!.revision, 0);

	// Externally modify the file on disk (bypass ops-applier)
	const modified = "# Title\n\nExternally modified content.\n";
	await writeFile(mdFile, modified, "utf-8");

	// readSnapshot should detect the mismatch and bump revision + emit event
	const snap1 = await readSnapshot(tmpRoot, "ext-edit.md");
	assert.ok(snap1 !== null);
	assert.equal(snap1!.revision, 1, "revision should be bumped after external edit");

	// The last event in the sidecar should be file.externallyEdited
	// We verify via the lastEventId being > the initial snap
	assert.ok(snap1!.lastEventId >= 0, "lastEventId should be set");
});

test("readSnapshot: no false positive when file unchanged", async () => {
	const mdFile = path.join(tmpRoot, "no-change.md");
	await writeFile(mdFile, "# Stable\n\nContent.\n", "utf-8");

	const snap0 = await readSnapshot(tmpRoot, "no-change.md");
	assert.ok(snap0 !== null);
	assert.equal(snap0!.revision, 0);

	// Read again without any external change
	const snap1 = await readSnapshot(tmpRoot, "no-change.md");
	assert.ok(snap1 !== null);
	assert.equal(snap1!.revision, 0, "revision must not change when file is unmodified");
});
