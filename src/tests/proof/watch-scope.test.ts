/**
 * Depth-scoped watch tests.
 *
 * Tests that depth-0 subscriptions only receive events for the watched
 * directory's own entries, not for files in subdirectories. Also verifies
 * pool keying, merge isolation, and unsubscribe cleanup.
 */
import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// ── Temp dirs ────────────────────────────────────────────────────────────────

let tmpRoots: string[] = [];

async function makeTmp(): Promise<string> {
	// Do NOT use tmpdir() or WIKI_TEST_HOME — on this system /tmp is a ZFS
	// dataset where chokidar's inotify does not fire events.
	// Use a project-local directory instead.
	const base = path.resolve(import.meta.dirname, "../../..");
	const d = await mkdtemp(path.join(base, "ws-test-"));
	tmpRoots.push(d);
	return d;
}

after(async () => {
	for (const d of tmpRoots) {
		await rm(d, { recursive: true, force: true });
	}
});

// ── Imports ──────────────────────────────────────────────────────────────────

import {
	subscribe,
	_resetWatcherPool,
	_poolSize,
	type WatchEvent,
} from "../../lib/search/watcher-pool.js";

afterEach(() => {
	_resetWatcherPool();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Poll until condition is met or timeout. */
async function pollUntil(
	fn: () => boolean,
	timeoutMs: number,
	intervalMs = 20,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

/** Collect events into an array and provide a wait helper. */
class EventCollector {
	events: Array<{ ev: WatchEvent; rel: string }> = [];
	unsub: (() => void) | null = null;

	listen(wsId: string, rootDir: string, depth?: number) {
		this.unsub = subscribe(wsId, rootDir, (ev, rel) => {
			this.events.push({ ev, rel });
		}, { depth });
	}

	/** Wait for the watcher to initialise (chokidar's 'ready' event). */
	async waitForReady(ms = 1500): Promise<void> {
		await new Promise((r) => setTimeout(r, ms));
	}

	async waitForCount(count: number, timeoutMs = 5000): Promise<void> {
		await pollUntil(() => this.events.length >= count, timeoutMs);
	}

	/** Wait for a specific event+rel combo to appear. */
	async waitFor(ev: WatchEvent, rel: string, timeoutMs = 5000): Promise<void> {
		await pollUntil(
			() => this.events.some((e) => e.ev === ev && e.rel === rel),
			timeoutMs,
		);
	}

	/** Clear events and unsub. */
	async done() {
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
		this.events = [];
	}
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("depth-0: file in watched dir produces event", async () => {
	const root = await makeTmp();
	const c = new EventCollector();
	c.listen("ws-d0", root, 0);
	await c.waitForReady();

	await writeFile(path.join(root, "a.md"), "# hello");
	await c.waitFor("add", "a.md");

	await c.done();
});

test("depth-0: file in subdirectory produces NO event", async () => {
	const root = await makeTmp();
	const sub = path.join(root, "sub");
	await mkdir(sub);

	const c = new EventCollector();
	c.listen("ws-d0", root, 0);
	await c.waitForReady();

	// Write a file two levels deep — must NOT be seen by a depth-0 watcher.
	await writeFile(path.join(sub, "b.md"), "# buried");

	// Poll 1.2s (6× the 200ms flush window) then assert zero events.
	// This is a genuine silence check, not a race-pass: if an event were
	// going to be delivered it would have been flushed long before 1.2s.
	await new Promise((r) => setTimeout(r, 1200));
	assert.equal(
		c.events.length,
		0,
		"depth-0 watcher must not receive events for files in subdirectories",
	);

	await c.done();
});

test("depth-0: new subdirectory produces addDir", async () => {
	const root = await makeTmp();
	const c = new EventCollector();
	c.listen("ws-d0", root, 0);
	await c.waitForReady();

	await mkdir(path.join(root, "sub2"));
	await c.waitFor("addDir", "sub2");

	await c.done();
});

test("depth-0: two subscribers on same dir share one watcher", async () => {
	const root = await makeTmp();

	const c1 = new EventCollector();
	const c2 = new EventCollector();
	c1.listen("ws-a", root, 0);
	c2.listen("ws-b", root, 0);

	assert.equal(_poolSize(), 1, "two depth-0 subscribers on same dir share a watcher");

	await c1.waitForReady();
	await writeFile(path.join(root, "shared.txt"), "data");

	await c1.waitFor("add", "shared.txt");
	await c2.waitFor("add", "shared.txt");

	await c1.done();
	await c2.done();
});

test("depth-0 + recursive: separate watchers, depth-0 isolated", async () => {
	const root = await makeTmp();
	const child = path.join(root, "child");
	const other = path.join(root, "other");
	await mkdir(child);
	await mkdir(other);

	// depth-0 on child first
	const cd0 = new EventCollector();
	cd0.listen("ws-child-d0", child, 0);
	assert.equal(_poolSize(), 1);

	await cd0.waitForReady();

	// recursive on root — must NOT absorb the depth-0 entry
	const cr = new EventCollector();
	cr.listen("ws-root-rec", root);
	assert.equal(_poolSize(), 2, "depth-0 and recursive must be separate watchers");

	await cr.waitForReady();

	// Write in child — both should see it (rebased per listener)
	await writeFile(path.join(child, "in-child.txt"), "cc");
	await cd0.waitFor("add", "in-child.txt");
	await cr.waitFor("add", "child/in-child.txt");

	// Write in other — depth-0 must NOT see it
	await writeFile(path.join(other, "deep.md"), "deep");
	await cr.waitFor("add", "other/deep.md");

	await new Promise((r) => setTimeout(r, 1200));
	const cd0GotDeep = cd0.events.some((e) => e.rel === "deep.md" || e.rel === "other/deep.md");
	assert.equal(
		cd0GotDeep,
		false,
		"depth-0 child watcher must not see root/other/deep.md",
	);

	await cd0.done();
	await cr.done();
});

test("depth-0: unsub last listener drops pool entry", async () => {
	const root = await makeTmp();

	const c = new EventCollector();
	c.listen("ws-d0", root, 0);
	assert.equal(_poolSize(), 1);

	await c.done();
	assert.equal(_poolSize(), 0, "unsubscribing last depth-0 listener removes watcher");
});
