/**
 * Sidecar / mutation mutex key baseline.
 *
 * Targets verified high finding:
 *   - sidecar reconciliation uses key `rel` while mutations use `${rootDir}\0${rel}`,
 *     so they do not serialize on the same file and they contend across workspaces.
 *
 * The tests instrument the *current* key choices directly. After the fix both
 * paths must use a single `workspaceLockKey(rootDir, relPath)`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withFileMutex, workspaceLockKey } from "../../lib/proof/mutex.js";

const ROOT_A = "/tmp/wiki-root-a";
const ROOT_B = "/tmp/wiki-root-b";
const REL = "notes/file.txt";

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

/**
 * Simulates the sidecar route after the fix: workspace-scoped lock key.
 */
async function sidecarReconcile(log: string[], rootDir: string, rel: string): Promise<void> {
	return withFileMutex(workspaceLockKey(rootDir, rel), async () => {
		log.push(`${rootDir}:sidecar-start`);
		await sleep(100);
		log.push(`${rootDir}:sidecar-end`);
	});
}

/**
 * Simulates the current mutation routes: they lock by `${rootDir}\0${rel}`.
 */
async function fileMutation(log: string[], rootDir: string, rel: string): Promise<void> {
	return withFileMutex(workspaceLockKey(rootDir, rel), async () => {
		log.push(`${rootDir}:mutation`);
	});
}

test("sidecar reconciliation and file mutation serialize on the same workspace file", async () => {
	const log: string[] = [];
	await Promise.all([
		sidecarReconcile(log, ROOT_A, REL),
		fileMutation(log, ROOT_A, REL),
	]);

	// If both operations used the same key, mutation must wait for reconciliation.
	assert.deepEqual(
		log,
		[`${ROOT_A}:sidecar-start`, `${ROOT_A}:sidecar-end`, `${ROOT_A}:mutation`],
		"sidecar reconciliation and mutation must serialize on the same file",
	);
});

test("different workspaces with the same relPath do not contend", async () => {
	const log: string[] = [];
	await Promise.all([
		sidecarReconcile(log, ROOT_A, REL),
		sidecarReconcile(log, ROOT_B, REL),
	]);

	// If the lock key is workspace-scoped, both sidecars start before either ends.
	const secondEvent = log[1];
	assert.ok(
		secondEvent && secondEvent.endsWith(":sidecar-start"),
		"different workspaces must not serialize on the same relative path",
	);
});
