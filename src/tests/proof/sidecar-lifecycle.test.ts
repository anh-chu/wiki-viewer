/**
 * Tests for moveSidecar, deleteSidecar, and wiki/move sidecar bug fix (R3).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	moveSidecar,
	deleteSidecar,
	writeSidecar,
	readSidecar,
	emptySidecar,
	sidecarPath,
} from "../../lib/proof/sidecar.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-sidecar-lifecycle-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

// --- moveSidecar ---

test("moveSidecar: moves sidecar file to new path", async () => {
	const from = "alpha.md";
	const to = "renamed/alpha.md";

	const sc = emptySidecar(from);
	sc.revision = 42;
	await writeSidecar(tmpRoot, from, sc);

	const srcPath = sidecarPath(tmpRoot, from);
	const destPath = sidecarPath(tmpRoot, to);

	await moveSidecar(tmpRoot, from, to);

	// Source gone
	await assert.rejects(() => access(srcPath), "source sidecar should be gone");
	// Dest present and correct
	const moved = await readSidecar(tmpRoot, to);
	assert.ok(moved, "destination sidecar should exist");
	assert.equal(moved!.revision, 42);
});

test("moveSidecar: no-op when sidecar does not exist", async () => {
	// Should not throw
	await moveSidecar(tmpRoot, "nonexistent.md", "also-nonexistent.md");
});

test("moveSidecar: creates intermediate dirs for destination", async () => {
	const from = "flat.md";
	const to = "deep/nested/dir/flat.md";

	const sc = emptySidecar(from);
	await writeSidecar(tmpRoot, from, sc);

	await moveSidecar(tmpRoot, from, to);

	const moved = await readSidecar(tmpRoot, to);
	assert.ok(moved, "destination sidecar should exist even in deep dir");
});

// --- deleteSidecar ---

test("deleteSidecar: deletes sidecar file", async () => {
	const mdPath = "to-delete.md";
	const sc = emptySidecar(mdPath);
	await writeSidecar(tmpRoot, mdPath, sc);

	const filePath = sidecarPath(tmpRoot, mdPath);
	// Verify it exists first
	await access(filePath); // throws if missing

	await deleteSidecar(tmpRoot, mdPath);

	await assert.rejects(() => access(filePath), "sidecar should be deleted");
});

test("deleteSidecar: no-op when sidecar does not exist", async () => {
	// Should not throw
	await deleteSidecar(tmpRoot, "never-existed.md");
});

// --- wiki/move route sidecar fix ---

test("wiki/move: moves sidecar alongside .md file rename", async () => {
	// Set up isolated tmp env
	const home = await mkdtemp(path.join(tmpdir(), "wiki-move-home-"));
	const root = await mkdtemp(path.join(tmpdir(), "wiki-move-root-"));

	try {
		process.env.HOME = home;
		process.env.ROOT_DIR = root;
		const { setRootDir } = await import("../../lib/root-dir.js");
		setRootDir(root);

		const { makeUserSession } = await import("./helpers/auth-session.js");
		const { POST } = await import("../../app/api/wiki/move/route.js");

		// Create a .md file + sidecar
		const fromRel = "moveme.md";
		const toRel = "moved-target.md";
		await writeFile(path.join(root, fromRel), "# Hello\n", "utf-8");

		const sc = emptySidecar(fromRel);
		sc.revision = 7;
		await writeSidecar(root, fromRel, sc);

		// Make an authenticated request
		const cookie = await makeUserSession();
		const req = new Request("http://localhost/api/wiki/move", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: cookie,
				Origin: "http://localhost",
			},
			body: JSON.stringify({ from: fromRel, to: toRel }),
		});

		const res = await POST(req);
		assert.equal(res.status, 200, "move should succeed");

		// Source sidecar gone
		const srcSidecarPath = sidecarPath(root, fromRel);
		await assert.rejects(() => access(srcSidecarPath), "source sidecar should be gone after move");

		// Destination sidecar present
		const destSidecar = await readSidecar(root, toRel);
		assert.ok(destSidecar, "destination sidecar should exist after move");
		assert.equal(destSidecar!.revision, 7, "sidecar data should be preserved");
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("wiki/move: non-.md moves don't call moveSidecar (no error)", async () => {
	const home = await mkdtemp(path.join(tmpdir(), "wiki-move-nm-home-"));
	const root = await mkdtemp(path.join(tmpdir(), "wiki-move-nm-root-"));

	try {
		process.env.HOME = home;
		process.env.ROOT_DIR = root;
		const { setRootDir } = await import("../../lib/root-dir.js");
		setRootDir(root);

		const { makeUserSession } = await import("./helpers/auth-session.js");
		const { POST } = await import("../../app/api/wiki/move/route.js");

		await writeFile(path.join(root, "data.json"), '{"x":1}', "utf-8");

		const cookie = await makeUserSession();
		const req = new Request("http://localhost/api/wiki/move", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: cookie,
				Origin: "http://localhost",
			},
			body: JSON.stringify({ from: "data.json", to: "data-renamed.json" }),
		});

		const res = await POST(req);
		assert.equal(res.status, 200, "non-.md move should succeed without error");
	} finally {
		await rm(home, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});
