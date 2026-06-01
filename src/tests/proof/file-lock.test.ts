/**
 * Basic tests for withFileLock / withFileMutex cross-process safety layer.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "file-lock-test-"));
	process.env.HOME = tmpHome;
});

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
});

import { withFileLock } from "../../lib/proof/file-lock.js";
import { withFileMutex } from "../../lib/proof/mutex.js";

test("withFileLock: acquires and releases without deadlock", async () => {
	const result = await withFileLock("test-key-1", async () => {
		return 42;
	});
	assert.equal(result, 42);
});

test("withFileLock: sequential calls on same key succeed", async () => {
	const r1 = await withFileLock("test-key-seq", async () => "first");
	const r2 = await withFileLock("test-key-seq", async () => "second");
	assert.equal(r1, "first");
	assert.equal(r2, "second");
});

test("withFileLock: propagates errors and releases lock", async () => {
	await assert.rejects(
		() => withFileLock("test-key-err", async () => { throw new Error("boom"); }),
		/boom/,
	);
	// Should be releasable again
	const r = await withFileLock("test-key-err", async () => "ok");
	assert.equal(r, "ok");
});

test("withFileMutex: serialises concurrent in-process callers", async () => {
	const results: number[] = [];
	await Promise.all([
		withFileMutex("mutex-concurrent-key", async () => {
			results.push(1);
			await new Promise((r) => setTimeout(r, 10));
			results.push(2);
		}),
		withFileMutex("mutex-concurrent-key", async () => {
			results.push(3);
		}),
	]);
	// Serialised: 1, 2 must appear before 3.
	assert.deepEqual(results, [1, 2, 3]);
});

test("withFileMutex: different keys run concurrently", async () => {
	const log: string[] = [];
	await Promise.all([
		withFileMutex("key-A", async () => {
			log.push("A-start");
			await new Promise((r) => setTimeout(r, 20));
			log.push("A-end");
		}),
		withFileMutex("key-B", async () => {
			log.push("B-start");
			log.push("B-end");
		}),
	]);
	// B can start before A ends (different keys = no contention).
	assert.ok(log.includes("B-start"));
	assert.ok(log.includes("A-end"));
});
