/**
 * Watcher pool + mount pruning tests.
 *
 * Tests the rewritten watcher-pool.ts (ancestor merge, per-listener rebasing,
 * throttle, error handling, rescan) and the new mounts.ts module (parsing,
 * classification, containment, caching).
 */
import { test, before, after, afterEach } from "node:test";
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
	const d = await mkdtemp(path.join(base, "wp-test-"));
	tmpRoots.push(d);
	return d;
}

after(async () => {
	for (const d of tmpRoots) {
		await rm(d, { recursive: true, force: true });
	}
});

// ── Mounts unit tests ────────────────────────────────────────────────────────

import {
	readMountTable,
	isHazardFsType,
	nestedHazardMounts,
	makeMountPruner,
	rootIsHazardMount,
	_injectMountReader,
	_resetMountReader,
	_clearMountCache,
} from "../../lib/fs/mounts.js";

afterEach(() => {
	_resetMountReader();
	_clearMountCache();
});

test("readMountTable() returns non-empty array containing / on Linux", () => {
	if (process.platform !== "linux") {
		// skip on non-Linux
		return;
	}
	const entries = readMountTable();
	assert.ok(entries.length > 0, "mount table should not be empty");
	const mountPoints = entries.map((e) => e.mountPoint);
	assert.ok(mountPoints.includes("/"), "mount table should include /");
});

test("readMountTable() with injectable fixture parses correctly", () => {
	const fixture = [
		"1 2 0:3 / / rw,relatime - zfs rpool/ROOT/ubuntu rw",
		"4 5 0:6 / /home rw,relatime - zfs rpool/USERDATA/home rw",
		"7 8 0:9 / /mnt/remote rw,nosuid - fuse.sshfs rw,user_id=1000",
		"10 11 0:12 / /run/user/1000/doc rw,nosuid - fuse.portal rw",
		// path with escaped space: \040 → " "
		"13 14 0:15 / /mnt/my\\040mount rw - nfs4 server:/export rw",
	].join("\n");

	_injectMountReader(() => fixture);
	const entries = readMountTable();

	assert.equal(entries.length, 5);
	assert.equal(entries[0].mountPoint, "/");
	assert.equal(entries[0].fsType, "zfs");
	assert.equal(entries[1].mountPoint, "/home");
	assert.equal(entries[1].fsType, "zfs");
	assert.equal(entries[2].mountPoint, "/mnt/remote");
	assert.equal(entries[2].fsType, "fuse.sshfs");
	assert.equal(entries[3].mountPoint, "/run/user/1000/doc");
	assert.equal(entries[3].fsType, "fuse.portal");
	assert.equal(entries[4].mountPoint, "/mnt/my mount"); // \040 decoded
	assert.equal(entries[4].fsType, "nfs4");
});

test("isHazardFsType classifies correctly", () => {
	assert.equal(isHazardFsType("fuse.sshfs"), true);
	assert.equal(isHazardFsType("fuse.rclone"), true);
	assert.equal(isHazardFsType("fuseblk"), true);
	assert.equal(isHazardFsType("nfs"), true);
	assert.equal(isHazardFsType("nfs4"), true);
	assert.equal(isHazardFsType("cifs"), true);
	assert.equal(isHazardFsType("smb3"), true);
	assert.equal(isHazardFsType("smbfs"), true);
	assert.equal(isHazardFsType("afs"), true);
	assert.equal(isHazardFsType("ceph"), true);
	assert.equal(isHazardFsType("glusterfs"), true);
	assert.equal(isHazardFsType("9p"), true);
	assert.equal(isHazardFsType("davfs"), true);

	// Safe filesystems
	assert.equal(isHazardFsType("zfs"), false);
	assert.equal(isHazardFsType("ext4"), false);
	assert.equal(isHazardFsType("xfs"), false);
	assert.equal(isHazardFsType("btrfs"), false);
	assert.equal(isHazardFsType("tmpfs"), false);
	assert.equal(isHazardFsType("overlay"), false);
});

test("nestedHazardMounts excludes root-equal mount, includes nested", () => {
	const fixture = [
		"1 2 0:3 / / rw - zfs rpool/ROOT rw",
		"4 5 0:6 / /mnt/remote rw - fuse.sshfs rw",
		"7 8 0:9 / /mnt/remote/deep rw - nfs4 server:/deep rw",
		"10 11 0:12 / /other rw - fuse.rclone rw",
	].join("\n");

	_injectMountReader(() => fixture);

	// rootDir = "/mnt/remote" (itself on fuse.sshfs)
	const nested = nestedHazardMounts("/mnt/remote");
	// Should NOT include /mnt/remote itself (equal to rootDir)
	assert.ok(!nested.includes("/mnt/remote"), "should exclude root-equal mount");
	// Should include /mnt/remote/deep (strictly inside)
	assert.ok(nested.includes("/mnt/remote/deep"), "should include nested hazard");
	// Should NOT include /other (outside rootDir)
	assert.ok(!nested.includes("/other"), "should exclude outside mount");
});

test("readMountTable caches within TTL", () => {
	let calls = 0;
	_injectMountReader(() => {
		calls++;
		return "1 2 0:3 / / rw - zfs rpool/ROOT rw\n";
	});

	readMountTable();
	assert.equal(calls, 1);
	readMountTable();
	assert.equal(calls, 1, "second call within TTL should use cache");
	// Force cache clear, then another call reads again
	_clearMountCache();
	readMountTable();
	assert.equal(calls, 2, "after cache clear should re-read");
});

test("makeMountPruner isPruned and refresh", () => {
	const fixture = [
		"1 2 0:3 / / rw - zfs rpool/ROOT rw",
		"4 5 0:6 / /mnt/bad rw - fuse.sshfs rw",
	].join("\n");

	_injectMountReader(() => fixture);
	const pruner = makeMountPruner("/");

	assert.equal(pruner.isPruned("/mnt/bad"), true);
	assert.equal(pruner.isPruned("/mnt/bad/sub/file.txt"), true);
	assert.equal(pruner.isPruned("/mnt/baddy"), false, "should not prefix-match /mnt/baddy");
	assert.equal(pruner.isPruned("/mnt"), false);
	assert.equal(pruner.isPruned("/home/user/file.txt"), false);

	assert.deepEqual(pruner.list(), ["/mnt/bad"]);
});

test("rootIsHazardMount detects root on fuse", () => {
	const fixture = [
		"1 2 0:3 / / rw - zfs rpool/ROOT rw",
		"4 5 0:6 / /mnt/remote rw - fuse.sshfs rw",
	].join("\n");

	_injectMountReader(() => fixture);

	assert.equal(rootIsHazardMount("/"), false);
	assert.equal(rootIsHazardMount("/mnt/remote"), true);
	assert.equal(rootIsHazardMount("/mnt/remote/"), true);
	assert.equal(rootIsHazardMount("/nonexistent"), false);
});

// ── Watcher pool integration tests ───────────────────────────────────────────

import {
	subscribe,
	_resetWatcherPool,
	_poolSize,
	_emitPoolError,
	_injectPendingEvent,
	type WatchEvent,
} from "../../lib/search/watcher-pool.js";

afterEach(() => {
	_resetWatcherPool();
});

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
	rootDir: string = "";

	listen(wsId: string, rootDir: string) {
		this.rootDir = rootDir;
		this.unsub = subscribe(wsId, rootDir, (ev, rel) => {
			this.events.push({ ev, rel });
		});
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

test("two wsIds on same root create one watcher", async () => {
	const root = await makeTmp();

	const c1 = new EventCollector();
	const c2 = new EventCollector();
	c1.listen("ws-a", root);
	c2.listen("ws-b", root);

	assert.equal(_poolSize(), 1, "should share one watcher");

	// Wait for watcher readiness, then write
	await c1.waitForReady();
	await writeFile(path.join(root, "shared.txt"), "hello");

	await c1.waitFor("add", "shared.txt");
	await c2.waitFor("add", "shared.txt");

	await c1.done();
	await c2.done();
});

test("ancestor merge: subscribing to parent promotes child watchers", async () => {
	const root = await makeTmp();
	const child = path.join(root, "child");
	await mkdir(child);

	// Subscribe to child first
	const cc = new EventCollector();
	cc.listen("ws-child", child);
	assert.equal(_poolSize(), 1);

	// Wait for child watcher ready
	await cc.waitForReady();

	// Subscribe to parent — should promote, not create second watcher
	const pc = new EventCollector();
	pc.listen("ws-parent", root);

	// Should still have one watcher (at the parent level)
	assert.equal(_poolSize(), 1);

	// Wait for promoted watcher ready (the child watcher was closed, new parent one created)
	await pc.waitForReady();

	// Write a file in child — both should receive, but with different relative paths
	await writeFile(path.join(child, "nested.txt"), "data");

	await cc.waitFor("add", "nested.txt");
	await pc.waitFor("add", "child/nested.txt");

	// Write a file in root — only parent should receive
	await writeFile(path.join(root, "rootfile.txt"), "data");
	await pc.waitFor("add", "rootfile.txt");

	// Give child collector a moment — should NOT receive root-level event
	await new Promise((r) => setTimeout(r, 500));
	const childEvents = cc.events.filter((e) => e.rel === "rootfile.txt");
	assert.equal(childEvents.length, 0, "child should not receive root-level events");

	await cc.done();
	await pc.done();
});

test("per-listener rebasing: sibling subtrees are isolated", async () => {
	const root = await makeTmp();
	const subA = path.join(root, "subA");
	const subB = path.join(root, "subB");
	await mkdir(subA);
	await mkdir(subB);

	const ca = new EventCollector();
	const cb = new EventCollector();

	// Subscribe to disjoint subtrees — two watchers, not merged
	ca.listen("ws-subA", subA);
	cb.listen("ws-subB", subB);

	assert.equal(_poolSize(), 2);

	// Wait for both watchers ready
	await ca.waitForReady();
	await cb.waitForReady();

	await writeFile(path.join(subA, "a.txt"), "a");
	await writeFile(path.join(subB, "b.txt"), "b");

	await ca.waitFor("add", "a.txt");
	await cb.waitFor("add", "b.txt");

	// ca should NOT receive b.txt, cb should NOT receive a.txt
	await new Promise((r) => setTimeout(r, 500));
	const caHasB = ca.events.some((e) => e.rel === "b.txt");
	const cbHasA = cb.events.some((e) => e.rel === "a.txt");
	assert.equal(caHasB, false, "subA listener should not get subB events");
	assert.equal(cbHasA, false, "subB listener should not get subA events");

	await ca.done();
	await cb.done();
});

test("throttle: burst of writes produces flush", async () => {
	const root = await makeTmp();
	const c = new EventCollector();
	c.listen("ws-burst", root);

	await c.waitForReady();

	// Write 50 distinct files as fast as possible
	const promises: Promise<void>[] = [];
	for (let i = 0; i < 50; i++) {
		promises.push(writeFile(path.join(root, `burst-${i}.txt`), `data ${i}`));
	}
	await Promise.all(promises);

	// Wait for events to arrive (throttled to one flush every 200ms)
	await c.waitForCount(50, 10000);

	// All 50 files should have add events
	const addedRels = new Set(c.events.filter((e) => e.ev === "add").map((e) => e.rel));
	for (let i = 0; i < 50; i++) {
		assert.ok(addedRels.has(`burst-${i}.txt`), `missing burst-${i}.txt`);
	}

	await c.done();
});

test("throwing listener does not prevent other listeners", async () => {
	const root = await makeTmp();

	const cGood = new EventCollector();

	let threw = false;
	const unsubBad = subscribe("ws-bad", root, () => {
		threw = true;
		throw new Error("boom");
	});
	cGood.listen("ws-good", root);

	await cGood.waitForReady();

	await writeFile(path.join(root, "test.txt"), "data");
	await cGood.waitFor("add", "test.txt");

	assert.equal(threw, true, "throwing listener should have been called");
	// Good listener still got the event
	assert.ok(cGood.events.some((e) => e.ev === "add" && e.rel === "test.txt"));

	unsubBad();
	await cGood.done();
});

test("_resetWatcherPool closes all watchers and clears state", async () => {
	const root = await makeTmp();
	const c = new EventCollector();
	c.listen("ws-reset", root);

	await c.waitForReady();
	assert.equal(_poolSize(), 1);

	_resetWatcherPool();
	assert.equal(_poolSize(), 0);

	// Write after reset — should get no events (watcher is closed)
	await writeFile(path.join(root, "after-reset.txt"), "data");
	await new Promise((r) => setTimeout(r, 1000));
	assert.equal(c.events.length, 0, "no events after reset");

	await c.done();
});

test("events are suppressed for the watched root itself", async () => {
	const root = await makeTmp();
	const c = new EventCollector();
	c.listen("ws-root-suppress", root);

	await c.waitForReady();

	// Create a directory inside root — the addDir event for the root itself
	// should be suppressed (rel would be empty string), but events for
	// contents should pass through.
	await mkdir(path.join(root, "subdir"));

	await c.waitFor("addDir", "subdir");

	// The root-level addDir should not appear
	const rootEvents = c.events.filter((e) => e.ev === "addDir" && e.rel === "");
	assert.equal(rootEvents.length, 0, "root-level addDir should be suppressed");

	await c.done();
});

// ── Regression: ancestor merge unsubscribe + queued-event preservation ───────

test("ancestor merge: pre-promotion unsubscribe detaches listener", async () => {
	const root = await makeTmp();
	const child = path.join(root, "child");
	await mkdir(child);

	// Subscribe to child directory first.
	const cc = new EventCollector();
	cc.listen("ws-child", child);
	await cc.waitForReady();

	// Capture the unsubscribe closure BEFORE promotion.
	const unsubChild = cc.unsub!;

	// Subscribe to parent — triggers ancestor promotion.
	const pc = new EventCollector();
	pc.listen("ws-parent", root);

	// Call the pre-promotion unsubscribe.
	// Pre-fix bug: this only deleted from the child entry, but the listener
	// had been copied to the parent entry during promotion, so it leaked.
	// After fix (detachListener): removed from whichever entry holds it.
	unsubChild();

	// Wait for the promoted watcher to be ready.
	await pc.waitForReady();

	// Write a NEW file in child — the parent watcher (at root) should detect it.
	await writeFile(path.join(child, "after-promote.txt"), "data");

	// Parent listener should receive the event.
	await pc.waitFor("add", "child/after-promote.txt");

	// Child listener was detached — must NOT receive it.
	await new Promise((r) => setTimeout(r, 500));
	const childGotIt = cc.events.some((e) => e.rel === "after-promote.txt");
	assert.equal(
		childGotIt,
		false,
		"detached child listener must not receive events after promotion",
	);

	await pc.done();
});

test("ancestor merge: queued event preserved across promotion", async () => {
	const root = await makeTmp();
	const child = path.join(root, "child");
	await mkdir(child);

	// Subscribe to child first.
	const cc = new EventCollector();
	cc.listen("ws-child", child);
	await cc.waitForReady();

	// Inject a pending event into the child watcher's throttle buffer.
	const absPath = path.join(child, "pending.txt");
	_injectPendingEvent(child, "add", absPath);

	// Subscribe to parent — triggers ancestor promotion.
	// The pending event must be transferred to the new parent watcher
	// before the old child watcher is closed.
	const pc = new EventCollector();
	pc.listen("ws-parent", root);

	// Pending event should be delivered to the original child listener,
	// rebased correctly to the child listener's own base (not the parent root).
	await cc.waitFor("add", "pending.txt");

	// Parent listener should receive the event rebased to parent root.
	await pc.waitFor("add", "child/pending.txt");

	await cc.done();
	await pc.done();
});

// ── Regression: rootIsHazardMount detects workspace below fuse mount ─────────

test("rootIsHazardMount detects workspace below fuse mount", () => {
	const fixture = [
		"1 2 0:3 / / rw - zfs rpool/ROOT rw",
		"4 5 0:6 / /mnt/sshfs rw - fuse.sshfs rw",
		"7 8 0:9 / /mnt/other rw - ext4 /dev/sdb1 rw",
	].join("\n");

	_injectMountReader(() => fixture);

	// Exact equality case (already worked pre-fix).
	assert.equal(rootIsHazardMount("/mnt/sshfs"), true, "exact match on fuse mount");

	// Ancestor case: workspace root BELOW a hazardous mount.
	// Pre-fix only accepted exact equality, so this returned false.
	assert.equal(
		rootIsHazardMount("/mnt/sshfs/project"),
		true,
		"workspace below fuse mount must be hazardous",
	);
	assert.equal(
		rootIsHazardMount("/mnt/sshfs/project/sub"),
		true,
		"deep workspace below fuse mount must be hazardous",
	);

	// Root that is NOT below any hazardous mount.
	assert.equal(
		rootIsHazardMount("/mnt/other"),
		false,
		"ext4 mount is not hazardous",
	);
	assert.equal(
		rootIsHazardMount("/mnt/other/project"),
		false,
		"workspace below non-hazardous mount is not hazardous",
	);
});

test("error budget emits rescan to pool listener", async () => {
	const root = await makeTmp();

	const c1 = new EventCollector();
	const c2 = new EventCollector();
	c1.listen("ws-a", root);
	c2.listen("ws-b", root);

	await c1.waitForReady();

	// Trip the error budget: MAX_WATCH_ERRORS = 20.
	for (let i = 0; i < 20; i++) {
		_emitPoolError(root);
	}

	// Every listener must receive a synthetic "rescan" event with empty path.
	// This pins the fix that special-cases rescan before the per-listener
	// rebasing guard (which previously rejected empty relative paths).
	await c1.waitFor("rescan", "");
	await c2.waitFor("rescan", "");

	// After degradation the watcher is closed — no more file events.
	await writeFile(path.join(root, "after-degrade.txt"), "data");
	await new Promise((r) => setTimeout(r, 1000));

	const fileEvents = c1.events.filter((e) => e.ev !== "rescan");
	assert.equal(fileEvents.length, 0, "no file events after degradation");

	await c1.done();
	await c2.done();
});
