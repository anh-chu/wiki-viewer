/**
 * Tests for src/lib/git-secrets.ts
 * PAT store: 0600 file, set/get/delete round-trip, isolation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Override HOME before importing the module so dataDir() picks up the temp dir.
let tmpHome: string;
let originalHome: string | undefined;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "wiki-git-secrets-test-"));
	originalHome = process.env.HOME;
	process.env.HOME = tmpHome;
});

after(async () => {
	if (originalHome !== undefined) process.env.HOME = originalHome;
	await rm(tmpHome, { recursive: true, force: true });
});

// Import lazily so HOME override takes effect before module-level code runs.
async function getModule() {
	// Use dynamic import with a cache-busting trick if needed.
	// In practice the HOME override happens before any import here.
	return import("../../lib/git-secrets.js");
}

test("genTokenRef returns a string starting with git_", async () => {
	const { genTokenRef } = await getModule();
	const ref = genTokenRef();
	assert.ok(ref.startsWith("git_"), `Expected 'git_' prefix, got: ${ref}`);
	assert.ok(ref.length > 5, "ref should be reasonably long");
});

test("genTokenRef is unique across calls", async () => {
	const { genTokenRef } = await getModule();
	const refs = new Set(Array.from({ length: 20 }, () => genTokenRef()));
	assert.equal(refs.size, 20, "refs should be unique");
});

test("setToken then getToken returns the token", async () => {
	const { genTokenRef, setToken, getToken } = await getModule();
	const ref = genTokenRef();
	await setToken(ref, "ghp_testtoken123");
	const retrieved = await getToken(ref);
	assert.equal(retrieved, "ghp_testtoken123");
});

test("getToken returns null for unknown ref", async () => {
	const { getToken } = await getModule();
	const result = await getToken("git_nonexistent_ref_xyz");
	assert.equal(result, null);
});

test("getToken returns null when secrets file does not exist", async () => {
	// Use a brand-new temp home with no secrets file.
	const freshHome = await mkdtemp(path.join(tmpdir(), "wiki-git-fresh-"));
	const savedHome = process.env.HOME;
	try {
		process.env.HOME = freshHome;
		// Re-import to pick up new HOME.
		const { getToken } = await import("../../lib/git-secrets.js");
		const result = await getToken("git_anything");
		assert.equal(result, null);
	} finally {
		process.env.HOME = savedHome;
		await rm(freshHome, { recursive: true, force: true });
	}
});

test("secrets file is created with mode 0600", async () => {
	const freshHome = await mkdtemp(path.join(tmpdir(), "wiki-git-perm-"));
	const savedHome = process.env.HOME;
	try {
		process.env.HOME = freshHome;
		const mod = await import("../../lib/git-secrets.js");
		const ref = mod.genTokenRef();
		await mod.setToken(ref, "token_perm_test");
		const secretsFile = path.join(freshHome, ".wiki-viewer", "git-secrets.json");
		assert.ok(existsSync(secretsFile), "secrets file should exist after setToken");
		const mode = statSync(secretsFile).mode & 0o777;
		assert.equal(mode, 0o600, `Expected 0600, got ${mode.toString(8)}`);
	} finally {
		process.env.HOME = savedHome;
		await rm(freshHome, { recursive: true, force: true });
	}
});

test("deleteToken removes the token", async () => {
	const { genTokenRef, setToken, getToken, deleteToken } = await getModule();
	const ref = genTokenRef();
	await setToken(ref, "ghp_to_delete");
	await deleteToken(ref);
	const result = await getToken(ref);
	assert.equal(result, null);
});

test("deleteToken is a no-op for nonexistent ref", async () => {
	const { deleteToken, getToken } = await getModule();
	// Should not throw
	await deleteToken("git_does_not_exist_abc");
	assert.equal(await getToken("git_does_not_exist_abc"), null);
});

test("multiple tokens stored independently", async () => {
	const { genTokenRef, setToken, getToken } = await getModule();
	const ref1 = genTokenRef();
	const ref2 = genTokenRef();
	await setToken(ref1, "token_one");
	await setToken(ref2, "token_two");
	assert.equal(await getToken(ref1), "token_one");
	assert.equal(await getToken(ref2), "token_two");
});

test("overwriting a token stores the new value", async () => {
	const { genTokenRef, setToken, getToken } = await getModule();
	const ref = genTokenRef();
	await setToken(ref, "old_token");
	await setToken(ref, "new_token");
	assert.equal(await getToken(ref), "new_token");
});

test("deleting one token does not affect others", async () => {
	const { genTokenRef, setToken, getToken, deleteToken } = await getModule();
	const ref1 = genTokenRef();
	const ref2 = genTokenRef();
	await setToken(ref1, "keep_me");
	await setToken(ref2, "delete_me");
	await deleteToken(ref2);
	assert.equal(await getToken(ref1), "keep_me");
	assert.equal(await getToken(ref2), null);
});
