/**
 * Watched-path budget: a root too large to watch must DEGRADE, not OOM.
 *
 * Regression guard for a real crash loop — a workspace registered at $HOME
 * containing an agent state dir (13k dirs / 336k files, mostly tiny checkpoints)
 * drove RSS to 1.7G and a 2.7G peak during chokidar's setup walk, then died of a
 * V8 heap OOM. The server accepted connections and never answered, so the symptom
 * was an endless spinner rather than an error.
 *
 * Env is set before importing watcher-pool because the budget is read once at
 * module load. node:test runs each file in its own process, so this is contained.
 */
import { test, after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

process.env.WIKI_MAX_WATCHED_PATHS = "5";

const { subscribe, _resetWatcherPool } = await import("../../lib/search/watcher-pool.js");

let tmp: string;
const cleanup: string[] = [];

// /tmp is a ZFS dataset here where chokidar's inotify doesn't fire; use a
// project-local dir, matching watcher-pool.test.ts.
async function makeTmp(): Promise<string> {
	const base = path.resolve(import.meta.dirname, "../../..");
	const d = await mkdtemp(path.join(base, "wb-test-"));
	cleanup.push(d);
	return d;
}

before(async () => {
	tmp = await makeTmp();
	// Comfortably over the budget of 5.
	for (let i = 0; i < 12; i++) {
		await mkdir(path.join(tmp, `d${i}`), { recursive: true });
		await writeFile(path.join(tmp, `d${i}`, "a.md"), "x");
		await writeFile(path.join(tmp, `d${i}`, "b.md"), "x");
	}
});

after(async () => {
	_resetWatcherPool();
	for (const d of cleanup) await rm(d, { recursive: true, force: true });
});

describe("watched-path budget", () => {
	test("an over-budget root degrades loudly instead of dying", async () => {
		const errors: string[] = [];
		const origErr = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};

		let unsub: (() => void) | undefined;
		try {
			// Must not throw, and must return a working unsubscribe.
			unsub = subscribe("ws_budget", tmp, () => {});
			assert.equal(typeof unsub, "function");
			// Give chokidar's setup walk time to offer paths to `ignored`.
			await new Promise((r) => setTimeout(r, 1200));
		} finally {
			console.error = origErr;
			unsub?.();
		}

		const budgetMsg = errors.find((e) => e.includes("exceeded 5 watched paths"));
		assert.ok(
			budgetMsg,
			`expected a budget warning naming the limit; got: ${JSON.stringify(errors)}`,
		);
		// The operator needs to know what to DO, not just that something happened.
		assert.match(budgetMsg, /degraded/);
		assert.match(budgetMsg, /scope the workspace to a subdirectory|SKIP_NAMES/);
	});

	test("the process survives and the pool is still usable afterwards", async () => {
		// The OOM took the whole server down; a degraded watcher must not.
		const other = await makeTmp();
		await writeFile(path.join(other, "only.md"), "x");
		const unsub = subscribe("ws_after", other, () => {});
		assert.equal(typeof unsub, "function");
		unsub();
	});
});
