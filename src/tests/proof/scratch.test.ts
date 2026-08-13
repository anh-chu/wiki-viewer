import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp,
	rm,
	mkdir,
	writeFile,
	readdir,
	utimes,
	symlink,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectScratchExt, detectCodeExt } from "../../lib/scratch/detect.js";
import {
	sanitizeExt,
	extFromFilename,
	newScratchRelPath,
	SCRATCH_DIR,
} from "../../lib/scratch/config.js";
import { sweepScratch } from "../../lib/scratch/sweep.js";
import { resolveWorkspacePath } from "../../lib/fs/workspace-path.js";

let root: string;

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "wiki-scratch-test-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("detectScratchExt classifies html", () => {
	assert.equal(detectScratchExt("<!doctype html><html><body>x</body></html>"), "html");
	assert.equal(detectScratchExt("<div><span>a</span></div>"), "html");
});

test("detectScratchExt classifies markdown", () => {
	assert.equal(detectScratchExt("# Title\n\nsome text"), "md");
	assert.equal(detectScratchExt("- one\n- two\n"), "md");
	assert.equal(detectScratchExt("see [link](http://x)"), "md");
});

test("detectScratchExt falls back to txt for prose", () => {
	assert.equal(detectScratchExt("just plain words here"), "txt");
});

test("detectCodeExt classifies common languages", () => {
	assert.equal(detectCodeExt("def foo(x):\n    return x"), "py");
	assert.equal(detectCodeExt("fn main() { println!(\"hi\"); }"), "rs");
	assert.equal(detectCodeExt("package main\nfunc main() {}"), "go");
	assert.equal(detectCodeExt("interface Foo { a: string }"), "ts");
	assert.equal(detectCodeExt('{"a":1,"b":[2,3]}'), "json");
	assert.equal(detectCodeExt("#!/bin/bash\necho hi"), "sh");
	assert.equal(detectCodeExt("the quick brown fox"), null);
});

test("detectScratchExt routes code before txt", () => {
	assert.equal(detectScratchExt("def f(x):\n    return x*2"), "py");
	assert.equal(detectScratchExt('{"k": "v"}'), "json");
});

test("sanitizeExt strips junk and caps", () => {
	assert.equal(sanitizeExt(".MD"), "md");
	assert.equal(sanitizeExt("t s x!!"), "tsx");
	assert.equal(sanitizeExt(""), "txt");
	assert.equal(sanitizeExt(undefined), "txt");
});

test("extFromFilename derives extension", () => {
	assert.equal(extFromFilename("report.PDF"), "pdf");
	assert.equal(extFromFilename("noext"), "txt");
	assert.equal(extFromFilename(".gitignore"), "txt");
});

test("newScratchRelPath lives under .scratch and is contained", async () => {
	const rel = newScratchRelPath("md");
	assert.ok(rel.startsWith(`${SCRATCH_DIR}/`));
	const res = await resolveWorkspacePath(root, rel, {
		allowMissing: true,
		deniedSegments: [".proof", ".git"],
	});
	assert.ok(res, "scratch path must resolve inside workspace");
	assert.ok(res.absolutePath.startsWith(root));
});

test("traversal scratch path is rejected", async () => {
	const res = await resolveWorkspacePath(root, "../escape.md", {
		allowMissing: true,
		deniedSegments: [".proof", ".git"],
	});
	assert.equal(res, null);
});

test("sweepScratch removes only stale files", async () => {
	const dir = path.join(root, SCRATCH_DIR);
	await mkdir(dir, { recursive: true });
	const oldFile = path.join(dir, "scratch-old.txt");
	const newFile = path.join(dir, "scratch-new.txt");
	await writeFile(oldFile, "old");
	await writeFile(newFile, "new");
	// Age the old file well beyond the TTL.
	const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	await utimes(oldFile, ancient, ancient);

	const removed = await sweepScratch(root);
	assert.equal(removed, 1);
	const remaining = await readdir(dir);
	assert.ok(remaining.includes("scratch-new.txt"));
	assert.ok(!remaining.includes("scratch-old.txt"));
});

test("sweepScratch is a no-op when dir missing", async () => {
	const empty = await mkdtemp(path.join(tmpdir(), "wiki-scratch-empty-"));
	const removed = await sweepScratch(empty);
	assert.equal(removed, 0);
	await rm(empty, { recursive: true, force: true });
});

test("sweepScratch ignores a .scratch symlink pointing outside root", async () => {
	const wsRoot = await mkdtemp(path.join(tmpdir(), "wiki-scratch-sym-"));
	const outside = await mkdtemp(path.join(tmpdir(), "wiki-scratch-out-"));
	// A stale file that lives OUTSIDE the workspace, reachable only via symlink.
	const victim = path.join(outside, "important.txt");
	await writeFile(victim, "do not delete");
	const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	await utimes(victim, ancient, ancient);
	// .scratch -> outside dir (escape attempt).
	await symlink(outside, path.join(wsRoot, ".scratch"), "dir");

	const removed = await sweepScratch(wsRoot);
	assert.equal(removed, 0);
	// The external file must still exist.
	await stat(victim);

	await rm(wsRoot, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});
