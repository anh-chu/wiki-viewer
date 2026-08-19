import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { containedWrite, hashContent } from "../../lib/fs/contained-write.js";

let home: string;
let rootDir: string;
let outsideDir: string;

before(async () => {
	home = await mkdtemp(path.join(tmpdir(), "contained-write-home-"));
	rootDir = await mkdtemp(path.join(tmpdir(), "contained-write-root-"));
	outsideDir = await mkdtemp(path.join(tmpdir(), "contained-write-outside-"));
	process.env.HOME = home;
});

after(async () => {
	await Promise.all([
		rm(home, { recursive: true, force: true }),
		rm(rootDir, { recursive: true, force: true }),
		rm(outsideDir, { recursive: true, force: true }),
	]);
});

test("writes content when base hash matches", async () => {
	const file = path.join(rootDir, "index.html");
	const before = "before";
	await writeFile(file, before, "utf8");

	const result = await containedWrite({
		rootDir,
		relPath: "index.html",
		expectedBaseHash: hashContent(before),
		content: "after",
	});

	assert.deepEqual(result, { ok: true, written: [file] });
	assert.equal(await readFile(file, "utf8"), "after");
});

test("refuses base drift and leaves file byte-identical", async () => {
	const file = path.join(rootDir, "drift.html");
	await writeFile(file, "changed-on-disk", "utf8");

	const result = await containedWrite({
		rootDir,
		relPath: "drift.html",
		expectedBaseHash: hashContent("proposal-base"),
		content: "candidate",
	});

	assert.deepEqual(result, { ok: false, code: "BASE_DRIFT", detail: "drift.html" });
	assert.equal(await readFile(file, "utf8"), "changed-on-disk");
});

test("rejects paths escaping the workspace root", async () => {
	const result = await containedWrite({
		rootDir,
		relPath: "../outside.txt",
		expectedBaseHash: hashContent(""),
		content: "blocked",
	});

	assert.deepEqual(result, { ok: false, code: "PATH_DENIED", detail: "../outside.txt" });
});

test("rejects a symlinked target", async () => {
	const outside = path.join(outsideDir, "secret.txt");
	await writeFile(outside, "secret", "utf8");
	await symlink(outside, path.join(rootDir, "linked.txt"));

	const result = await containedWrite({
		rootDir,
		relPath: "linked.txt",
		expectedBaseHash: hashContent("secret"),
		content: "blocked",
	});

	assert.deepEqual(result, { ok: false, code: "PATH_DENIED", detail: "linked.txt" });
	assert.equal(await readFile(outside, "utf8"), "secret");
});
