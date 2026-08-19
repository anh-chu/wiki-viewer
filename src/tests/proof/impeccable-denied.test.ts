import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWorkspacePath } from "../../lib/fs/workspace-path.js";
import { DENIED_SEGMENTS } from "../../lib/fs/denied-segments.js";
import { safeWorkspacePath } from "../../lib/workspaces.js";

let rootDir: string;

before(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "wiki-impeccable-root-"));
	await writeFile(path.join(rootDir, "normal.txt"), "ok");
});

after(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

test("denies .impeccable at workspace root", async () => {
	assert.equal(
		await resolveWorkspacePath(rootDir, ".impeccable", {
			allowMissing: true,
			deniedSegments: DENIED_SEGMENTS,
		}),
		null,
	);
});

test("denies paths below .impeccable", async () => {
	assert.equal(
		await resolveWorkspacePath(rootDir, ".impeccable/live/x", {
			allowMissing: true,
			deniedSegments: DENIED_SEGMENTS,
		}),
		null,
	);
});

test("denies nested .impeccable segments", async () => {
	assert.equal(
		await resolveWorkspacePath(rootDir, "foo/.impeccable/bar", {
			allowMissing: true,
			deniedSegments: DENIED_SEGMENTS,
		}),
		null,
	);
});

test("allows ordinary workspace paths", async () => {
	const resolved = await resolveWorkspacePath(rootDir, "normal.txt", {
		deniedSegments: DENIED_SEGMENTS,
	});
	assert.ok(resolved);
	assert.equal(resolved?.absolutePath, path.join(rootDir, "normal.txt"));
});

test("safeWorkspacePath denies .impeccable across the routes that gate on it (F2)", () => {
	assert.equal(safeWorkspacePath(rootDir, ".impeccable"), null);
	assert.equal(safeWorkspacePath(rootDir, ".impeccable/live/server.json"), null);
	assert.equal(safeWorkspacePath(rootDir, "foo/.impeccable/bar"), null);
	// Regression guard: existing denied segments still rejected, normal path ok.
	assert.equal(safeWorkspacePath(rootDir, ".proof/x"), null);
	assert.equal(safeWorkspacePath(rootDir, ".git/config"), null);
	assert.equal(safeWorkspacePath(rootDir, "normal.txt"), path.join(rootDir, "normal.txt"));
});

test("continues denying .proof and .git", async () => {
	for (const deniedPath of [".proof/sidecar.json", ".git/config"]) {
		assert.equal(
			await resolveWorkspacePath(rootDir, deniedPath, {
				allowMissing: true,
				deniedSegments: DENIED_SEGMENTS,
			}),
			null,
		);
	}
});
