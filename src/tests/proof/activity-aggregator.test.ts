import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	aggregateActivity,
	deriveConnections,
	ACTIVITY_DEFAULT_LIMIT,
	ACTIVITY_MAX_LIMIT,
} from "../../lib/proof/activity.js";
import type { Sidecar } from "../../lib/proof/types.js";

let tmpRoot: string;

function makeSidecar(filePath: string, eventCount: number, byPrefix = "agent"): Sidecar {
	const now = Date.now();
	return {
		schemaVersion: 1,
		path: filePath,
		revision: 0,
		createdAt: new Date(now).toISOString(),
		updatedAt: new Date(now).toISOString(),
		refMap: {},
		refAliases: {},
		comments: [],
		suggestions: [],
		archivedSuggestions: [],
		events: Array.from({ length: eventCount }, (_, i) => ({
			id: i + 1,
			type: "block.replace",
			at: new Date(now - (eventCount - i) * 1000).toISOString(),
			by: `${byPrefix}-${i % 2}`,
			ref: `b00000${i}`,
		})),
		nextEventId: eventCount + 1,
		lastAck: {},
		fingerprint: "",
		blockProvenance: {},
	};
}

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-activity-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeSidecarFile(sc: Sidecar): Promise<void> {
	const dest = path.join(tmpRoot, ".proof", sc.path + ".json");
	await mkdir(path.dirname(dest), { recursive: true });
	await writeFile(dest, JSON.stringify(sc), "utf-8");
}

test("aggregates events from 3 sidecar files", async () => {
	const sc1 = makeSidecar("notes/a.md", 5, "alice");
	const sc2 = makeSidecar("notes/b.md", 5, "bob");
	const sc3 = makeSidecar("notes/c.md", 5, "carol");
	await writeSidecarFile(sc1);
	await writeSidecarFile(sc2);
	await writeSidecarFile(sc3);

	const events = await aggregateActivity(tmpRoot);
	assert.equal(events.length, 15);
});

test("events include path field from sidecar", async () => {
	const events = await aggregateActivity(tmpRoot);
	for (const ev of events) {
		assert.ok(typeof ev.path === "string", "event has path field");
	}
	const paths = new Set(events.map((e) => e.path));
	assert.ok(paths.has("notes/a.md"));
	assert.ok(paths.has("notes/b.md"));
	assert.ok(paths.has("notes/c.md"));
});

test("events sorted newest first", async () => {
	const events = await aggregateActivity(tmpRoot);
	for (let i = 0; i < events.length - 1; i++) {
		assert.ok(
			events[i].at >= events[i + 1].at,
			`event[${i}].at >= event[${i + 1}].at`,
		);
	}
});

test("limit respected", async () => {
	const events = await aggregateActivity(tmpRoot, { limit: 7 });
	assert.equal(events.length, 7);
});

test("limit capped at ACTIVITY_MAX_LIMIT", async () => {
	const events = await aggregateActivity(tmpRoot, { limit: 99999 });
	assert.ok(events.length <= ACTIVITY_MAX_LIMIT);
});

test("default limit is ACTIVITY_DEFAULT_LIMIT", async () => {
	const events = await aggregateActivity(tmpRoot);
	assert.ok(events.length <= ACTIVITY_DEFAULT_LIMIT);
});

test("file filter returns only matching sidecar events", async () => {
	const events = await aggregateActivity(tmpRoot, { file: "notes/a.md" });
	assert.ok(events.length > 0, "should have events");
	for (const ev of events) {
		assert.equal(ev.path, "notes/a.md");
	}
	assert.equal(events.length, 5);
});

test("file filter on non-existent path returns empty", async () => {
	const events = await aggregateActivity(tmpRoot, { file: "ghost.md" });
	assert.equal(events.length, 0);
});

test("aggregateActivity returns empty when .proof missing", async () => {
	const emptyRoot = await mkdtemp(path.join(tmpdir(), "wiki-activity-empty-"));
	try {
		const events = await aggregateActivity(emptyRoot);
		assert.equal(events.length, 0);
	} finally {
		await rm(emptyRoot, { recursive: true, force: true });
	}
});

test("deriveConnections groups by 'by' field within 5 min", async () => {
	const now = new Date().toISOString();
	const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
	const events = [
		{ id: 1, type: "block.replace", at: now, by: "alice", path: "a.md" },
		{ id: 2, type: "block.replace", at: now, by: "alice", path: "a.md" },
		{ id: 3, type: "block.replace", at: now, by: "bob", path: "b.md" },
		{ id: 4, type: "block.replace", at: old, by: "carol", path: "c.md" },
	];
	const conns = deriveConnections(events);
	assert.equal(conns.length, 2, "carol excluded (too old)");
	const alice = conns.find((c) => c.by === "alice");
	assert.ok(alice, "alice present");
	assert.equal(alice!.opCount, 2);
	const bob = conns.find((c) => c.by === "bob");
	assert.ok(bob, "bob present");
	assert.equal(bob!.opCount, 1);
});
