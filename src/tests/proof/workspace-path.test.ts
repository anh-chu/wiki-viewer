/**
 * Workspace path containment baseline.
 *
 * Tests the current path primitives (`safeWorkspacePath` and `safeAbsPath`)
 * that will be consolidated into `resolveWorkspacePath()` in stream S2.
 *
 * Exposes:
 *   - denied segments (.proof / .git) not enforced by `safeWorkspacePath`
 *   - `safeAbsPath` accepts a missing descendant under an existing symlink
 *     because it only realpaths the immediate parent
 *   - traversal, absolute, and NUL inputs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	rm,
	mkdtemp,
	symlink,
	writeFile,
	mkdir,
	access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const { safeWorkspacePath } = await import("../../lib/workspaces.js");
const { safeAbsPath } = await import("../../lib/proof/raw-fs.js");

let rootDir: string;
let outsideDir: string;

before(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "wiki-path-root-"));
	outsideDir = await mkdtemp(path.join(tmpdir(), "wiki-path-outside-"));

	await writeFile(path.join(rootDir, "existing.txt"), "ok");
	await mkdir(path.join(rootDir, "dir"), { recursive: true });
	await symlink(outsideDir, path.join(rootDir, "link"));
	await writeFile(path.join(outsideDir, "outside.txt"), "outside");
});

after(async () => {
	await rm(rootDir, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
});

// ─── safeWorkspacePath (lexical guard eventually replaced by real containment)

test("safeWorkspacePath rejects .. traversal", () => {
	assert.equal(safeWorkspacePath(rootDir, "../outside.txt"), null);
});

test("safeWorkspacePath rejects absolute path", () => {
	assert.equal(safeWorkspacePath(rootDir, "/etc/passwd"), null);
});

test("safeWorkspacePath rejects .proof by segment equality", () => {
	assert.equal(safeWorkspacePath(rootDir, ".proof/sidecar.json"), null);
});

test("safeWorkspacePath rejects .git by segment equality", () => {
	assert.equal(safeWorkspacePath(rootDir, ".git/config"), null);
});

test("safeWorkspacePath allows ordinary workspace file", () => {
	const resolved = safeWorkspacePath(rootDir, "existing.txt");
	assert.ok(resolved);
	assert.ok(path.isAbsolute(resolved));
});

// ─── safeAbsPath (symlink-aware, but nearest-ancestor bug)

test("safeAbsPath rejects existing symlink escape", async () => {
	const resolved = await safeAbsPath(rootDir, "link/outside.txt");
	assert.equal(resolved, null, "existing symlink target outside root must be rejected");
});

test("safeAbsPath rejects nested missing target through symlink", async () => {
	const resolved = await safeAbsPath(rootDir, "link/new/file.txt");
	assert.equal(
		resolved,
		null,
		"mkdirs-style create through symlink must be rejected",
	);
	// Confidence: current bug would return a path, so also guard the filesystem.
	if (resolved !== null) {
		await assert.rejects(
			access(path.join(outsideDir, "new")),
			{ code: "ENOENT" },
		);
	}
});

test("safeAbsPath rejects .. traversal", async () => {
	assert.equal(await safeAbsPath(rootDir, "../outside.txt"), null);
});

test("safeAbsPath rejects absolute path", async () => {
	assert.equal(await safeAbsPath(rootDir, "/etc/passwd"), null);
});

test("safeAbsPath rejects NUL byte", async () => {
	assert.equal(await safeAbsPath(rootDir, "file\0.txt"), null);
});

test("safeAbsPath allows valid create under root", async () => {
	const resolved = await safeAbsPath(rootDir, "dir/new/file.txt");
	assert.ok(resolved);
	assert.ok(path.isAbsolute(resolved));
	assert.ok(resolved.startsWith(rootDir + path.sep));
});
